// Worktree service and git helpers.
// Provides reusable, Discord-agnostic worktree creation/merge logic,
// submodule initialization, and git diff transfer utilities.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDataDir } from './config.js'
import { execAsync } from './exec-async.js'
import { createLogger, LogPrefix } from './logger.js'
import { deleteThreadWorktree, getThreadWorktree, setWorktreeReady } from './database.js'

export { execAsync } from './exec-async.js'

const SUBMODULE_INIT_TIMEOUT_MS = 20 * 60_000
const INSTALL_TIMEOUT_MS = 60_000

const logger = createLogger(LogPrefix.WORKTREE)

const LOCKFILE_TO_INSTALL_COMMAND: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm install'],
  ['bun.lock', 'bun install'],
  ['bun.lockb', 'bun install'],
  ['yarn.lock', 'yarn install'],
  ['package-lock.json', 'npm install'],
]

function detectInstallCommand(directory: string): string | null {
  for (const [lockfile, command] of LOCKFILE_TO_INSTALL_COMMAND) {
    if (fs.existsSync(path.join(directory, lockfile))) {
      return command
    }
  }
  return null
}

/**
 * Run the detected package manager install in a worktree directory.
 * Non-fatal: returns Error on failure/timeout so callers can log and continue.
 * The 60s timeout kills the process if install hangs.
 */
export async function runDependencyInstall({
  directory,
}: {
  directory: string
}): Promise<void | Error> {
  const installCommand = detectInstallCommand(directory)
  if (!installCommand) {
    return
  }
  logger.log(`Running "${installCommand}" in ${directory} (timeout=${INSTALL_TIMEOUT_MS}ms)`)
  try {
    await execAsync(installCommand, {
      cwd: directory,
      timeout: INSTALL_TIMEOUT_MS,
    })
    logger.log(`Dependencies installed in ${directory}`)
  } catch (e) {
    return new Error(`Install failed: ${formatCommandError(e)}`, { cause: e })
  }
}

type CommandError = Error & {
  cmd?: string
  stderr?: string
  stdout?: string
  signal?: NodeJS.Signals
  killed?: boolean
}

function formatCommandError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const commandError = error as CommandError
  const details: string[] = [commandError.message]

  if (commandError.cmd) {
    details.push(`cmd=${commandError.cmd}`)
  }
  if (commandError.signal) {
    details.push(`signal=${commandError.signal}`)
  }
  if (commandError.killed) {
    details.push('process=killed')
  }
  if (commandError.stderr?.trim()) {
    details.push(`stderr=${commandError.stderr.trim()}`)
  }
  if (commandError.stdout?.trim()) {
    details.push(`stdout=${commandError.stdout.trim()}`)
  }

  return details.join(' | ')
}

type GitSubmoduleConfig = {
  name: string
  path: string
  url: string | null
}

export type SubmoduleReferencePlan = {
  path: string
  referenceDirectory: string | null
}

export function parseGitmodulesFileContent(
  gitmodulesContent: string,
): GitSubmoduleConfig[] | Error {
  const lines = gitmodulesContent.split('\n')
  const configs: GitSubmoduleConfig[] = []
  let currentName: string | null = null
  let currentPath: string | null = null
  let currentUrl: string | null = null

  const flushCurrent = (): void | Error => {
    if (!currentName) {
      return
    }
    if (!currentPath) {
      return new Error(`Submodule ${currentName} is missing path in .gitmodules`)
    }
    configs.push({
      name: currentName,
      path: currentPath,
      url: currentUrl,
    })
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue
    }

    const sectionMatch = line.match(/^\[submodule\s+"([^"]+)"\]$/)
    if (sectionMatch?.[1]) {
      const flushError = flushCurrent()
      if (flushError instanceof Error) return flushError

      currentName = sectionMatch[1]
      currentPath = null
      currentUrl = null
      continue
    }

    if (!currentName) {
      continue
    }

    const keyValueMatch = line.match(/^([^=\s]+)\s*=\s*(.*)$/)
    const key = keyValueMatch?.[1]
    const value = keyValueMatch?.[2]
    if (!key || value === undefined) {
      continue
    }

    if (key === 'path') {
      currentPath = value
      continue
    }

    if (key === 'url') {
      currentUrl = value
    }
  }

  const flushError = flushCurrent()
  if (flushError instanceof Error) return flushError

  return configs
}

async function readSubmoduleConfigs(directory: string): Promise<GitSubmoduleConfig[] | Error> {
  const gitmodulesPath = path.join(directory, '.gitmodules')
  const gitmodulesExists = await fs.promises
    .access(gitmodulesPath)
    .then(() => {
      return true
    })
    .catch(() => {
      return false
    })
  if (!gitmodulesExists) {
    return []
  }

  const gitmodulesContent = await fs.promises.readFile(gitmodulesPath, 'utf-8').catch(
    (e) =>
      new Error(`Failed to read ${gitmodulesPath}`, {
        cause: e,
      }),
  )
  if (gitmodulesContent instanceof Error) return gitmodulesContent

  const parsed = parseGitmodulesFileContent(gitmodulesContent)
  if (parsed instanceof Error) {
    return new Error(`Failed to parse ${gitmodulesPath}: ${parsed.message}`, {
      cause: parsed,
    })
  }

  return parsed
}

export function buildSubmoduleReferencePlan({
  sourceDirectory,
  submodulePaths,
  existingSourceSubmoduleDirectories,
}: {
  sourceDirectory: string
  submodulePaths: string[]
  existingSourceSubmoduleDirectories: Set<string>
}): SubmoduleReferencePlan[] {
  return submodulePaths.map((submodulePath) => {
    const sourceSubmoduleDirectory = path.resolve(sourceDirectory, submodulePath)
    if (existingSourceSubmoduleDirectories.has(sourceSubmoduleDirectory)) {
      return {
        path: submodulePath,
        referenceDirectory: sourceSubmoduleDirectory,
      }
    }

    return {
      path: submodulePath,
      referenceDirectory: null,
    }
  })
}

function buildGitCommand(args: string[]): string {
  const quotedArgs = args.map((arg) => {
    return JSON.stringify(arg)
  })
  return `git ${quotedArgs.join(' ')}`
}

export function buildSubmoduleUpdateCommandArgs({
  path: submodulePath,
  referenceDirectory,
}: SubmoduleReferencePlan): string[] {
  if (referenceDirectory) {
    return [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--reference',
      referenceDirectory,
      '--',
      submodulePath,
    ]
  }

  return [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--recursive',
    '--',
    submodulePath,
  ]
}

async function hasSubmoduleGitMetadata(directory: string): Promise<boolean> {
  const gitPath = path.join(directory, '.git')
  return fs.promises
    .access(gitPath)
    .then(() => {
      return true
    })
    .catch(() => {
      return false
    })
}

async function initializeSubmodulesWithLocalReferences({
  sourceDirectory,
  worktreeDirectory,
}: {
  sourceDirectory: string
  worktreeDirectory: string
}): Promise<void | Error> {
  const submoduleConfigs = await readSubmoduleConfigs(worktreeDirectory)
  if (submoduleConfigs instanceof Error) return submoduleConfigs
  if (submoduleConfigs.length === 0) {
    return
  }

  const sourceDirectories = submoduleConfigs.map(({ path: submodulePath }) => {
    return path.resolve(sourceDirectory, submodulePath)
  })

  const sourceDirectoryChecks = await Promise.all(
    sourceDirectories.map(async (sourceSubmoduleDirectory) => {
      const exists = await hasSubmoduleGitMetadata(sourceSubmoduleDirectory)
      return { sourceSubmoduleDirectory, exists }
    }),
  )

  const existingSourceSubmoduleDirectories = new Set(
    sourceDirectoryChecks
      .filter(({ exists }) => {
        return exists
      })
      .map(({ sourceSubmoduleDirectory }) => {
        return sourceSubmoduleDirectory
      }),
  )

  const submodulePlan = buildSubmoduleReferencePlan({
    sourceDirectory,
    submodulePaths: submoduleConfigs.map(({ path: submodulePath }) => {
      return submodulePath
    }),
    existingSourceSubmoduleDirectories,
  })

  for (const planItem of submodulePlan) {
    const commandArgs = buildSubmoduleUpdateCommandArgs(planItem)
    const command = buildGitCommand(commandArgs)
    const result = await execAsync(command, {
      cwd: worktreeDirectory,
      timeout: SUBMODULE_INIT_TIMEOUT_MS,
    }).catch(
      (e) =>
        new Error(
          `git ${commandArgs.join(' ')} failed for ${planItem.path}: ${formatCommandError(e)}`,
          { cause: e },
        ),
    )
    if (result instanceof Error) {
      // Non-fatal: broken .gitmodules entries (e.g. path listed but not in tree)
      // should not block worktree creation. Log and continue with remaining submodules.
      logger.warn(`Skipping submodule ${planItem.path}: ${result.message}`)
    }
  }
}

/**
 * Get submodule paths from .gitmodules file.
 * Returns empty array if no submodules or on error.
 */
async function getSubmodulePaths(directory: string): Promise<string[]> {
  const submoduleConfigs = await readSubmoduleConfigs(directory)
  if (submoduleConfigs instanceof Error) {
    logger.warn(`Failed reading submodules from ${directory}: ${submoduleConfigs.message}`)
    return []
  }

  return submoduleConfigs.map(({ path: submodulePath }) => {
    return submodulePath
  })
}

/**
 * Remove broken submodule stubs created by git worktree.
 * When git worktree add runs on a repo with submodules, it creates submodule
 * directories with .git files pointing to ../.git/worktrees/<name>/modules/<submodule>
 * but that path only has a config file, missing HEAD/objects/refs.
 * This causes git commands to fail with "fatal: not a git repository".
 */
async function removeBrokenSubmoduleStubs(directory: string): Promise<void> {
  const submodulePaths = await getSubmodulePaths(directory)

  for (const subPath of submodulePaths) {
    const fullPath = path.join(directory, subPath)
    const gitFile = path.join(fullPath, '.git')

    try {
      const stat = await fs.promises.stat(gitFile)
      if (!stat.isFile()) {
        continue
      }

      // Read .git file to get gitdir path
      const content = await fs.promises.readFile(gitFile, 'utf-8')
      const match = content.match(/^gitdir:\s*(.+)$/m)
      if (!match || !match[1]) {
        continue
      }

      const gitdir = path.resolve(fullPath, match[1].trim())
      const headFile = path.join(gitdir, 'HEAD')

      // If HEAD doesn't exist, this is a broken stub
      const headExists = await fs.promises
        .access(headFile)
        .then(() => {
          return true
        })
        .catch(() => {
          return false
        })

      if (!headExists) {
        logger.log(`Removing broken submodule stub: ${subPath}`)
        await fs.promises.rm(fullPath, { recursive: true, force: true })
      }
    } catch {
      // Directory doesn't exist or other error, skip
    }
  }
}

function parseSubmoduleGitdir(gitFileContent: string): string | Error {
  const match = gitFileContent.match(/^gitdir:\s*(.+)$/m)
  const gitdir = match?.[1]?.trim()
  if (!gitdir) {
    return new Error('Missing gitdir pointer')
  }
  return gitdir
}

async function validateSubmodulePointers(directory: string): Promise<void | Error> {
  const submodulePaths = await getSubmodulePaths(directory)
  if (submodulePaths.length === 0) {
    return
  }

  const validationIssues: string[] = []

  await Promise.all(
    submodulePaths.map(async (submodulePath) => {
      const submoduleDir = path.join(directory, submodulePath)
      const submoduleGitFile = path.join(submoduleDir, '.git')

      const gitFileExists = await fs.promises
        .access(submoduleGitFile)
        .then(() => {
          return true
        })
        .catch(() => {
          return false
        })
      if (!gitFileExists) {
        validationIssues.push(`${submodulePath}: missing .git file`)
        return
      }

      const gitFileContentResult = await fs.promises
        .readFile(submoduleGitFile, 'utf-8')
        .catch((e) => new Error(`Failed to read .git for ${submodulePath}`, { cause: e }))
      if (gitFileContentResult instanceof Error) {
        validationIssues.push(`${submodulePath}: ${gitFileContentResult.message}`)
        return
      }

      const parsedGitdir = parseSubmoduleGitdir(gitFileContentResult)
      if (parsedGitdir instanceof Error) {
        validationIssues.push(`${submodulePath}: ${parsedGitdir.message}`)
        return
      }

      const resolvedGitdir = path.resolve(submoduleDir, parsedGitdir)
      const headPath = path.join(resolvedGitdir, 'HEAD')
      const headExists = await fs.promises
        .access(headPath)
        .then(() => {
          return true
        })
        .catch(() => {
          return false
        })
      if (!headExists) {
        validationIssues.push(`${submodulePath}: gitdir missing HEAD (${resolvedGitdir})`)
      }
    }),
  )

  const submoduleStatusResult = await execAsync('git submodule status --recursive', {
    cwd: directory,
    timeout: SUBMODULE_INIT_TIMEOUT_MS,
  }).catch((e) => new Error('git submodule status --recursive failed', { cause: e }))
  if (submoduleStatusResult instanceof Error) {
    validationIssues.push(submoduleStatusResult.message)
  }

  if (validationIssues.length === 0) {
    return
  }

  return new Error(`Submodule validation failed: ${validationIssues.join('; ')}`)
}

type WorktreeResult = {
  directory: string
  branch: string
}

async function resolveDefaultWorktreeTarget(directory: string): Promise<string> {
  return 'HEAD'
}

/**
 * Build the on-disk directory for a managed worktree.
 *
 * Layout: `<kimakiDataDir>/worktrees/<8charProjectHash>/<basename>`
 *
 * - Lives under the kimaki data dir instead of the long
 *   `~/.local/share/opencode/worktree/<40-char-hash>/<name>` path so folder
 *   names stay short and readable (agents tend to give up and reuse the old
 *   worktree when paths get absurdly long).
 * - The 8-char project hash keeps worktrees from different projects that
 *   happen to share a slug from colliding.
 * - Strips the `opencode/kimaki-` (or `opencode-kimaki-`) prefix from the
 *   folder name since it's redundant noise on disk. The git branch name
 *   itself still uses `opencode/kimaki-<slug>` so merge/cleanup logic is
 *   unchanged.
 */
export function getManagedWorktreeDirectory({
  directory,
  name,
}: {
  directory: string
  name: string
}): string {
  const projectHash = crypto.createHash('sha1').update(directory).digest('hex').slice(0, 8)
  const withoutPrefix = name.replace(/^opencode\/kimaki-/, '').replaceAll('/', '-')
  return path.join(getDataDir(), 'worktrees', projectHash, withoutPrefix)
}

/**
 * Create a worktree using git and initialize git submodules.
 * This wrapper ensures submodules are properly set up in new worktrees.
 */
export async function createWorktreeWithSubmodules({
  directory,
  name,
  baseBranch,
  onProgress,
}: {
  directory: string
  name: string
  /** Override the base branch to create the worktree from. Defaults to HEAD. */
  baseBranch?: string
  /** Called with a short phase label so callers can update UI (e.g. Discord status message). */
  onProgress?: (phase: string) => void
}): Promise<WorktreeResult | Error> {
  // 1. Create worktree via git (checked out immediately).
  const worktreeDir = getManagedWorktreeDirectory({ directory, name })
  const targetRef = baseBranch || (await resolveDefaultWorktreeTarget(directory))

  if (fs.existsSync(worktreeDir)) {
    return new Error(`Worktree directory already exists: ${worktreeDir}`)
  }

  await fs.promises.mkdir(path.dirname(worktreeDir), { recursive: true })

  const createCommand = `git worktree add ${JSON.stringify(worktreeDir)} -B ${JSON.stringify(name)} ${JSON.stringify(targetRef)}`
  const createResult = await execAsync(createCommand, {
    cwd: directory,
    timeout: SUBMODULE_INIT_TIMEOUT_MS,
  }).catch(
    (e) =>
      new Error(`git worktree add failed: ${formatCommandError(e)}`, {
        cause: e,
      }),
  )
  if (createResult instanceof Error) return createResult

  // 2. Remove broken submodule stubs before init
  // git worktree creates stub directories with .git files pointing to incomplete gitdirs
  await removeBrokenSubmoduleStubs(worktreeDir)

  // 4. Init submodules in new worktree.
  // For each submodule we use git's built-in --reference mechanism when the
  // source checkout already has that submodule cloned. This preserves commit
  // pinning while allowing local-only submodule commits to resolve reliably.
  logger.log(`Initializing submodules in ${worktreeDir} (timeout=${SUBMODULE_INIT_TIMEOUT_MS}ms)`)
  const submoduleInitResult = await initializeSubmodulesWithLocalReferences({
    sourceDirectory: directory,
    worktreeDirectory: worktreeDir,
  })
  if (submoduleInitResult instanceof Error) {
    // Non-fatal: log and continue. The worktree itself is already created,
    // only submodule init had issues (e.g. stale .gitmodules entries).
    logger.error('Submodule initialization failed (non-fatal)', {
      worktreeDir,
      timeoutMs: SUBMODULE_INIT_TIMEOUT_MS,
      command: 'git submodule update --init --recursive [--reference ...]',
      error: submoduleInitResult.message,
    })
  } else {
    logger.log(`Submodules initialized in ${worktreeDir}`)
  }

  // 4.5 Validate submodule pointers and git metadata.
  // Non-fatal: stale .gitmodules entries (path listed but removed from tree)
  // should not block worktree creation.
  const submoduleValidationError = await validateSubmodulePointers(worktreeDir)
  if (submoduleValidationError instanceof Error) {
    logger.error('Submodule validation issues (non-fatal)', {
      worktreeDir,
      error: submoduleValidationError.message,
    })
  }

  // 5. Dependency install (non-fatal, 60s timeout).
  // Runs the detected package manager install so workspace packages with
  // `prepare` scripts get built (e.g. errore → dist/).
  onProgress?.('Installing dependencies...')
  const installResult = await runDependencyInstall({ directory: worktreeDir })
  if (installResult instanceof Error) {
    logger.error('Dependency install failed (non-fatal)', {
      worktreeDir,
      error: installResult.message,
    })
  }

  return { directory: worktreeDir, branch: name }
}

// ─── Worktree merge ──────────────────────────────────────────────────────────
// Merge pipeline (preserves all worktree commits, no squash):
//   1. Reject if uncommitted changes exist
//   2. Rebase worktree commits onto target (default branch)
//   3. Fast-forward push to target via local git push
//   4. Switch to detached HEAD, delete branch
//
// Uses `git push <git-common-dir> HEAD:<target>` with
// `receive.denyCurrentBranch=updateInstead` to fast-forward the target
// WITHOUT checking it out in the main repo.
//
// Returns MergeWorktreeErrors | MergeSuccess. All errors are tagged via errore.
// - DirtyWorktreeError         → git untouched
// - NothingToMergeError        → git untouched
// - RebaseConflictError        → git left mid-rebase for AI/user resolution
// - RebaseError                → rebase not in progress; temp branch cleaned
// - NotFastForwardError        → source intact; no push
// - TargetDirtyWorktreeError   → target branch is checked out and dirty; no push
// - PushError                  → source rebased but target unchanged
// - GitCommandError            → catch-all for unexpected git failures

import {
  DirtyWorktreeError,
  NothingToMergeError,
  RebaseConflictError,
  RebaseError,
  NotFastForwardError,
  TargetDirtyWorktreeError,
  PushError,
  GitCommandError,
  type MergeWorktreeErrors,
} from './errors.js'

export type MergeSuccess = {
  defaultBranch: string
  branchName: string
  commitCount: number
  shortSha: string
}

export type RecoverWorktreeResult =
  | {
      recovered: false
      reason:
        | 'no-worktree-entry'
        | 'dir-exists'
        | 'project-missing'
        | 'branch-missing'
        | 'creation-failed'
      error?: Error
    }
  | { recovered: true; worktreeDirectory: string; worktreeName: string }

/**
 * Attempt to recreate a missing worktree directory from git.
 * Takes worktree info directly (no DB dependency) — testable in unit tests.
 */
export async function recoverWorktreeFromInfo({
  projectDirectory,
  worktreeName,
  worktreeDirectory,
}: {
  projectDirectory: string
  worktreeName: string
  worktreeDirectory: string
}): Promise<RecoverWorktreeResult> {
  // Detect old path format and treat as missing
  const isOldPathFormat = worktreeDirectory.includes('/.local/share/opencode/worktree/')

  // If directory exists at NEW path format, no recovery needed
  if (!isOldPathFormat && fs.existsSync(worktreeDirectory)) {
    return { recovered: false, reason: 'dir-exists' }
  }

  // If project directory is gone, can't recover
  if (!fs.existsSync(projectDirectory)) {
    return { recovered: false, reason: 'project-missing' }
  }

  // Check if the git branch still exists
  const branchCheck = await git(projectDirectory, `rev-parse --verify ${worktreeName}`)
  if (branchCheck instanceof Error) {
    return { recovered: false, reason: 'branch-missing', error: branchCheck }
  }

  // Recreate the worktree
  const result = await createWorktreeWithSubmodules({
    directory: projectDirectory,
    name: worktreeName,
  })

  if (result instanceof Error) {
    return { recovered: false, reason: 'creation-failed', error: result }
  }

  const recoveredDir = getManagedWorktreeDirectory({
    directory: projectDirectory,
    name: worktreeName,
  })
  return { recovered: true, worktreeDirectory: recoveredDir, worktreeName }
}

export async function git(
  dir: string,
  args: string,
  opts?: { timeout?: number },
): Promise<GitCommandError | string> {
  const result = await execAsync(
    `git -C "${dir}" ${args}`,
    opts ? { timeout: opts.timeout } : undefined,
  ).catch((e) => new GitCommandError({ command: args, cause: e }))
  if (result instanceof Error) return result
  return result.stdout.trim()
}

export async function getDefaultBranch(
  repoDir: string,
  opts?: { timeout?: number },
): Promise<string> {
  const ref = await git(repoDir, 'symbolic-ref refs/remotes/origin/HEAD', opts)
  if (ref instanceof Error) return 'main'
  return ref.replace(/^refs\/remotes\/origin\//, '') || 'main'
}

export async function deleteWorktree({
  projectDirectory,
  worktreeDirectory,
  worktreeName,
}: {
  projectDirectory: string
  worktreeDirectory: string
  // Branch name to delete after removing the worktree.
  // Pass empty string for detached HEAD worktrees — branch deletion is skipped.
  worktreeName: string
}): Promise<void | Error> {
  let removeResult = await git(
    projectDirectory,
    `worktree remove ${JSON.stringify(worktreeDirectory)}`,
    {
      timeout: SUBMODULE_INIT_TIMEOUT_MS,
    },
  )
  // git refuses to remove worktrees with submodule entries:
  // "fatal: working trees containing submodules cannot be moved or removed"
  // Retry with --force which bypasses this guard. This is safe because
  // canDeleteWorktree already verified the worktree is clean and merged.
  if (removeResult instanceof Error) {
    const stderr = (removeResult.cause as { stderr?: string } | undefined)?.stderr ?? ''
    if (stderr.includes('containing submodules')) {
      removeResult = await git(
        projectDirectory,
        `worktree remove --force ${JSON.stringify(worktreeDirectory)}`,
        { timeout: SUBMODULE_INIT_TIMEOUT_MS },
      )
    }
  }
  if (removeResult instanceof Error) {
    return new Error(`Failed to remove worktree ${worktreeName || worktreeDirectory}`, {
      cause: removeResult,
    })
  }

  // Skip branch deletion for detached HEAD worktrees (no branch to delete)
  if (worktreeName) {
    const deleteBranchResult = await git(
      projectDirectory,
      `branch -d ${JSON.stringify(worktreeName)}`,
    )
    if (deleteBranchResult instanceof Error) {
      return new Error(`Failed to delete branch ${worktreeName}`, {
        cause: deleteBranchResult,
      })
    }
  }

  const pruneResult = await git(projectDirectory, 'worktree prune')
  if (pruneResult instanceof Error) {
    logger.warn(`Failed to prune worktrees after deleting ${worktreeName || worktreeDirectory}`)
  }
}

export async function isDirty(dir: string, opts?: { timeout?: number }): Promise<boolean> {
  const status = await git(dir, 'status --porcelain', opts)
  if (status instanceof Error) return false
  return status.length > 0
}

export async function isGitRepositoryRoot(directory: string): Promise<boolean> {
  const topLevel = await git(directory, 'rev-parse --show-toplevel')
  if (topLevel instanceof Error) return false
  return path.resolve(topLevel) === path.resolve(directory)
}

async function getGitCommonDir(dir: string): Promise<GitCommandError | string> {
  const commonDir = await git(dir, 'rev-parse --git-common-dir')
  if (commonDir instanceof Error) return commonDir
  if (path.isAbsolute(commonDir)) {
    return commonDir
  }
  return path.resolve(dir, commonDir)
}

async function isAncestor({
  dir,
  ref1,
  ref2,
}: {
  dir: string
  ref1: string
  ref2: string
}): Promise<boolean> {
  const result = await git(dir, `merge-base --is-ancestor "${ref1}" "${ref2}"`)
  return !(result instanceof Error)
}

async function isRebasedOnto(dir: string, target: string): Promise<boolean> {
  const mergeBase = await git(dir, `merge-base HEAD "${target}"`)
  if (mergeBase instanceof Error) return false
  const targetSha = await git(dir, `rev-parse "${target}"`)
  if (targetSha instanceof Error) return false
  return mergeBase === targetSha
}

/**
 * Check if updateInstead would have to update a dirty checked-out target.
 * Git rejects local pushes to the current branch when that worktree is dirty,
 * even if the dirty files do not overlap with the incoming commits.
 */
async function isCheckedOutTargetDirty({
  targetDir,
  targetBranch,
}: {
  targetDir: string
  targetBranch: string
}): Promise<boolean> {
  const currentBranch = await git(targetDir, 'symbolic-ref --short HEAD')
  if (currentBranch instanceof Error || currentBranch !== targetBranch) {
    return false
  }
  return await isDirty(targetDir)
}

/**
 * Check if git is mid-rebase by looking for rebase-merge or rebase-apply dirs.
 */
async function isRebaseInProgress(dir: string): Promise<boolean> {
  for (const rebaseDir of ['rebase-merge', 'rebase-apply']) {
    const gitPath = await git(dir, `rev-parse --git-path ${rebaseDir}`)
    if (gitPath instanceof Error) continue
    const resolvedPath = path.isAbsolute(gitPath) ? gitPath : path.resolve(dir, gitPath)
    const exists = await fs.promises
      .access(resolvedPath)
      .then(() => {
        return true
      })
      .catch(() => {
        return false
      })
    if (exists) {
      return true
    }
  }
  return false
}

/**
 * Merge a worktree branch into the default branch by rebasing all commits
 * onto target, then fast-forward pushing. Preserves every worktree commit.
 * Returns MergeWorktreeErrors | MergeSuccess.
 */
export async function mergeWorktree({
  worktreeDir,
  mainRepoDir,
  worktreeName,
  targetBranch,
  onProgress,
}: {
  worktreeDir: string
  mainRepoDir: string
  worktreeName: string
  /** Override the branch to merge into. Defaults to origin/HEAD (or main). */
  targetBranch?: string
  onProgress?: (message: string) => void
}): Promise<MergeWorktreeErrors | MergeSuccess> {
  const log = (msg: string) => {
    logger.log(msg)
    onProgress?.(msg)
  }

  // Resolve current branch. If detached, create a temp branch.
  let branchName: string
  let tempBranch: string | null = null
  const branchResult = await git(worktreeDir, 'symbolic-ref --short HEAD')
  if (branchResult instanceof Error) {
    tempBranch = `kimaki-merge-${Date.now()}`
    const createResult = await git(worktreeDir, `checkout -b "${tempBranch}"`)
    if (createResult instanceof Error) return createResult
    branchName = tempBranch
  } else {
    branchName = branchResult || worktreeName
  }

  const defaultBranch = targetBranch || (await getDefaultBranch(mainRepoDir))
  log(`Merging ${branchName} into ${defaultBranch}`)

  // Best-effort cleanup of temp branch on error paths
  const cleanupTempBranch = async () => {
    if (!tempBranch) {
      return
    }

    const detachResult = await git(worktreeDir, 'checkout --detach')
    if (detachResult instanceof Error) {
      logger.warn(
        `[MERGE CLEANUP] Failed to detach HEAD before deleting temp branch: ${detachResult.message}`,
      )
    }

    const deleteTempBranchResult = await git(worktreeDir, `branch -D "${tempBranch}"`)
    if (deleteTempBranchResult instanceof Error) {
      logger.warn(
        `[MERGE CLEANUP] Failed to delete temp branch ${tempBranch}: ${deleteTempBranchResult.message}`,
      )
    }
  }

  // ── Step 1: If a rebase is already paused mid-flight, surface it ──
  // This happens when the user reruns /merge-worktree while the model is
  // still resolving conflicts. With multi-commit rebases, each conflict
  // leaves staged conflict markers (isDirty would say yes) AND merge-base
  // may already equal target (isRebasedOnto would say yes), so neither
  // of those checks is safe to run first. We must detect the in-progress
  // rebase explicitly and route back to the AI-resolve flow.
  if (await isRebaseInProgress(worktreeDir)) {
    return new RebaseConflictError({ target: defaultBranch })
  }

  // ── Step 2: Reject uncommitted changes ──
  if (await isDirty(worktreeDir)) {
    await cleanupTempBranch()
    return new DirtyWorktreeError()
  }

  // ── Step 3: Rebase worktree commits onto target ──
  // If already rebased onto target AND no rebase is in progress, skip
  // rebase entirely. The in-progress check above guarantees the second
  // half; we keep it implicit here.
  const alreadyRebased = await isRebasedOnto(worktreeDir, defaultBranch)

  const mergeBaseResult = await git(worktreeDir, `merge-base HEAD "${defaultBranch}"`)
  const mergeBase = mergeBaseResult instanceof Error ? defaultBranch : mergeBaseResult

  const commitCountResult = await git(worktreeDir, `rev-list --count "${mergeBase}..HEAD"`)
  if (commitCountResult instanceof Error) {
    await cleanupTempBranch()
    return commitCountResult
  }
  const commitCount = parseInt(commitCountResult, 10)

  if (commitCount === 0) {
    await cleanupTempBranch()
    return new NothingToMergeError({ target: defaultBranch })
  }

  if (!alreadyRebased) {
    // Rebase all worktree commits onto target, preserving each commit.
    log(
      commitCount > 1
        ? `Rebasing ${commitCount} commits onto ${defaultBranch}...`
        : `Rebasing onto ${defaultBranch}...`,
    )
    const rebaseResult = await git(worktreeDir, `rebase "${defaultBranch}"`, {
      timeout: 60_000,
    })
    if (rebaseResult instanceof Error) {
      if (await isRebaseInProgress(worktreeDir)) {
        return new RebaseConflictError({
          target: defaultBranch,
          cause: rebaseResult,
        })
      }
      await cleanupTempBranch()
      return new RebaseError({ target: defaultBranch, cause: rebaseResult })
    }
  } else {
    log('Already rebased onto target')
  }

  // ── Step 4: Fast-forward push via local git push ──
  if (!(await isAncestor({ dir: worktreeDir, ref1: defaultBranch, ref2: 'HEAD' }))) {
    await cleanupTempBranch()
    return new NotFastForwardError({ target: defaultBranch })
  }

  const targetIsDirty = await isCheckedOutTargetDirty({
    targetDir: mainRepoDir,
    targetBranch: defaultBranch,
  })
  if (targetIsDirty) {
    await cleanupTempBranch()
    return new TargetDirtyWorktreeError({ target: defaultBranch })
  }

  const gitCommonDir = await getGitCommonDir(worktreeDir)
  if (gitCommonDir instanceof Error) {
    await cleanupTempBranch()
    return gitCommonDir
  }

  log(`Pushing to ${defaultBranch}...`)
  const pushResult = await git(
    worktreeDir,
    `push --receive-pack="git -c receive.denyCurrentBranch=updateInstead receive-pack" "${gitCommonDir}" "HEAD:${defaultBranch}"`,
    { timeout: 30_000 },
  )
  if (pushResult instanceof Error) {
    await cleanupTempBranch()
    return new PushError({ target: defaultBranch, cause: pushResult })
  }

  // Get short SHA for display
  const shortSha = await git(worktreeDir, 'rev-parse --short HEAD')
  if (shortSha instanceof Error) {
    // Push succeeded but can't get SHA -- non-fatal, use placeholder
    logger.warn('Failed to get short SHA after push')
  }

  // ── Step 5: Clean up -- detach HEAD and delete branch ──
  log('Cleaning up worktree...')
  const detachResult = await git(worktreeDir, `checkout --detach "${defaultBranch}"`)
  if (detachResult instanceof Error) {
    logger.warn(
      `[MERGE CLEANUP] Failed to detach worktree HEAD after push: ${detachResult.message}`,
    )
  }

  const deleteBranchResult = await git(worktreeDir, `branch -D "${branchName}"`)
  if (deleteBranchResult instanceof Error) {
    logger.warn(
      `[MERGE CLEANUP] Failed to delete branch ${branchName}: ${deleteBranchResult.message}`,
    )
  }

  if (branchName !== worktreeName && worktreeName) {
    const deleteWorktreeBranchResult = await git(worktreeDir, `branch -D "${worktreeName}"`)
    if (deleteWorktreeBranchResult instanceof Error) {
      logger.warn(
        `[MERGE CLEANUP] Failed to delete worktree branch ${worktreeName}: ${deleteWorktreeBranchResult.message}`,
      )
    }
  }

  return {
    defaultBranch,
    branchName: worktreeName || branchName,
    commitCount,
    shortSha: shortSha instanceof Error ? 'unknown' : shortSha,
  }
}

/**
 * List branches sorted by most recent commit date.
 * Returns branch short names (e.g. "main", "origin/feature-x").
 * Filters by optional query string (case-insensitive substring match).
 * Limited to 25 results for Discord autocomplete.
 *
 * @param includeRemote - When true (default), includes remote tracking branches (`-a` flag).
 *   Set to false for merge targets where only local branches make sense.
 */
export async function listBranchesByLastCommit({
  directory,
  query,
  includeRemote = true,
}: {
  directory: string
  query?: string
  includeRemote?: boolean
}): Promise<string[]> {
  const branchFlag = includeRemote ? '-a' : ''
  const result = await git(
    directory,
    `branch ${branchFlag} --sort=-committerdate --format=%(refname:short)`,
  )
  if (result instanceof Error) return []

  const lowerQuery = query?.toLowerCase() || ''
  return result
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((name) => {
      if (!name) {
        return false
      }
      // Skip HEAD pointer entries like "origin/HEAD -> origin/main"
      if (name.includes('->')) {
        return false
      }
      if (!lowerQuery) {
        return true
      }
      return name.toLowerCase().includes(lowerQuery)
    })
    .slice(0, 25)
}

/**
 * Validate that a branch name is safe for use in git commands.
 * Uses `git check-ref-format --branch` which rejects names with shell metacharacters,
 * double dots, trailing dots/locks, etc. Returns the normalized name or an Error.
 */
export async function validateBranchRef({
  directory,
  ref,
}: {
  directory: string
  ref: string
}): Promise<string | Error> {
  const result = await git(directory, `check-ref-format --branch ${JSON.stringify(ref)}`)
  if (result instanceof Error) return new Error(`Invalid branch name: ${ref}`)
  return result
}

/**
 * Validate that a directory is a git worktree of the given project.
 * Parses `git worktree list --porcelain` from the project directory and
 * checks that the candidate path appears as one of the listed worktrees.
 * Returns the resolved absolute path on success, or an Error on failure.
 */
export async function validateWorktreeDirectory({
  projectDirectory,
  candidatePath,
}: {
  projectDirectory: string
  candidatePath: string
}): Promise<string | Error> {
  const absoluteCandidate = path.resolve(candidatePath)

  if (!fs.existsSync(absoluteCandidate)) {
    return new Error(`Directory does not exist: ${absoluteCandidate}`)
  }

  const result = await git(projectDirectory, 'worktree list --porcelain')
  if (result instanceof Error) return new Error('Failed to list git worktrees', { cause: result })

  const worktreePaths = result
    .split('\n')
    .filter((line) => {
      return line.startsWith('worktree ')
    })
    .map((line) => {
      return line.slice('worktree '.length)
    })

  if (!worktreePaths.includes(absoluteCandidate)) {
    return new Error(`Directory is not a git worktree of ${projectDirectory}: ${absoluteCandidate}`)
  }

  return absoluteCandidate
}

/**
 * Recovers a worktree directory that has an old path format or is missing.
 * Detects old paths like ~/.local/share/opencode/worktree/... and migrates
 * the worktree to the new path format instead of recreating.
 */
export async function recoverWorktreeDirectory({
  threadId,
}: {
  threadId: string
}): Promise<{ recovered: boolean; reason?: string; worktreeDirectory?: string } | Error> {
  const worktreeInfo = await getThreadWorktree(threadId)
  if (!worktreeInfo || worktreeInfo.status !== 'ready' || !worktreeInfo.worktree_directory) {
    return { recovered: false, reason: 'no-worktree' }
  }

  const worktreeDirectory = worktreeInfo.worktree_directory
  const projectDirectory = worktreeInfo.project_directory

  // Detect old path format (~/.local/share/opencode/worktree/...) and treat as missing
  const isOldPathFormat = worktreeDirectory.includes('/.local/share/opencode/worktree/')
  const worktreeName = worktreeInfo.worktree_name

  // If directory already exists and is NOT old format, no recovery needed
  if (!isOldPathFormat && fs.existsSync(worktreeDirectory)) {
    // Create backwards-compat symlink for any existing sessions that still
    // reference the old path format (~/.local/share/opencode/worktree/...)
    if (worktreeName) {
      createOldPathSymlink({
        projectDirectory,
        worktreeName,
        newWorktreeDirectory: worktreeDirectory,
      })
    }
    return { recovered: false, reason: 'dir-exists' }
  }

  // Directory is missing or has old path format - need to recover
  logger.log(
    `[RECOVER WORKTREE] Worktree directory needs recovery: ${worktreeDirectory} (oldFormat=${isOldPathFormat}, exists=${fs.existsSync(worktreeDirectory)})`,
  )
  if (!worktreeName) {
    return new Error('Cannot recover worktree: missing worktree_name in database')
  }

  // Calculate the new path
  const newWorktreeDirectory = getManagedWorktreeDirectory({
    directory: projectDirectory,
    name: worktreeName,
  })

  // If old path exists, try to migrate it
  if (isOldPathFormat && fs.existsSync(worktreeDirectory)) {
    logger.log(
      `[RECOVER WORKTREE] Migrating from old path to new path: ${worktreeDirectory} -> ${newWorktreeDirectory}`,
    )

    try {
      // Ensure parent directory exists
      await fs.promises.mkdir(path.dirname(newWorktreeDirectory), { recursive: true })

      // Try git worktree move first (preserves git metadata)
      const moveResult = await git(
        projectDirectory,
        `worktree move ${JSON.stringify(worktreeDirectory)} ${JSON.stringify(newWorktreeDirectory)}`,
      )

      if (moveResult instanceof Error) {
        // If move fails, fall back to rename
        logger.warn(
          `[RECOVER WORKTREE] git worktree move failed: ${moveResult.message}, falling back to fs.rename`,
        )
        await fs.promises.rename(worktreeDirectory, newWorktreeDirectory)
      }

      logger.log(`[RECOVER WORKTREE] Successfully migrated to: ${newWorktreeDirectory}`)

      // Update DB with new path
      await setWorktreeReady({ threadId, worktreeDirectory: newWorktreeDirectory })

      // Create backwards-compat symlink from old path format to new path
      createOldPathSymlink({ projectDirectory, worktreeName, newWorktreeDirectory })

      return { recovered: true, reason: 'migrated', worktreeDirectory: newWorktreeDirectory }
    } catch (error) {
      logger.error(
        `[RECOVER WORKTREE] Migration failed: ${error instanceof Error ? error.message : error}`,
      )
      // Fall through to recreation logic
    }
  }

  // Directory doesn't exist or migration failed - recreate
  logger.log(`[RECOVER WORKTREE] Recreating worktree at: ${newWorktreeDirectory}`)

  // Delete the stale worktree entry from DB
  await deleteThreadWorktree(threadId)

  // Create a new worktree
  const createResult = await createWorktreeWithSubmodules({
    directory: projectDirectory,
    name: worktreeName,
  })

  if (createResult instanceof Error) {
    logger.error(`[RECOVER WORKTREE] Failed to recreate worktree: ${createResult.message}`)
    return createResult
  }

  // Update DB with the new path
  await setWorktreeReady({ threadId, worktreeDirectory: createResult.directory })

  // Create backwards-compat symlink from old path format to new path
  createOldPathSymlink({
    projectDirectory,
    worktreeName,
    newWorktreeDirectory: createResult.directory,
  })

  logger.log(`[RECOVER WORKTREE] Successfully recovered worktree: ${createResult.directory}`)
  return { recovered: true, reason: 'recreated', worktreeDirectory: createResult.directory }
}

/**
 * Create a symlink from the old worktree path format (~/.local/share/opencode/worktree/...)
 * to the new path (~/.kimaki/worktrees/...) for backwards compatibility.
 * This allows existing opencode sessions that were created with old path references
 * to continue working without aborting the session.
 */
function createOldPathSymlink({
  projectDirectory,
  worktreeName,
  newWorktreeDirectory,
}: {
  projectDirectory: string
  worktreeName: string
  newWorktreeDirectory: string
}): void {
  const fullHash = crypto.createHash('sha1').update(projectDirectory).digest('hex')
  const oldName = worktreeName.replaceAll('/', '-')
  const oldPath = path.join(
    os.homedir(),
    '.local',
    'share',
    'opencode',
    'worktree',
    fullHash,
    oldName,
  )

  if (fs.existsSync(oldPath)) {
    // Already exists — either real dir or symlink from a prior recovery
    return
  }

  fs.mkdirSync(path.dirname(oldPath), { recursive: true })
  fs.symlinkSync(newWorktreeDirectory, oldPath, 'dir')
  logger.log(`[WORKTREE] Created backwards-compat symlink: ${oldPath} -> ${newWorktreeDirectory}`)
}

export type SessionWorkingDirectory = {
  kind: 'project' | 'worktree'
  directory: string
}

function isSameOrInsideDirectory({
  parentDirectory,
  candidateDirectory,
}: {
  parentDirectory: string
  candidateDirectory: string
}) {
  const relativePath = path.relative(parentDirectory, candidateDirectory)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

export async function resolveSessionWorkingDirectory({
  projectDirectory,
  candidatePath,
}: {
  projectDirectory: string
  candidatePath: string
}): Promise<SessionWorkingDirectory | Error> {
  const absoluteProjectDirectory = path.resolve(projectDirectory)
  const absoluteCandidate = path.resolve(candidatePath)

  const stat = await fs.promises.stat(absoluteCandidate).catch((error) => {
    return new Error(`Directory does not exist: ${absoluteCandidate}`, {
      cause: error,
    })
  })
  if (stat instanceof Error) return stat
  if (!stat.isDirectory()) {
    return new Error(`Path is not a directory: ${absoluteCandidate}`)
  }

  if (
    isSameOrInsideDirectory({
      parentDirectory: absoluteProjectDirectory,
      candidateDirectory: absoluteCandidate,
    })
  ) {
    return { kind: 'project', directory: absoluteCandidate }
  }

  const worktreeResult = await validateWorktreeDirectory({
    projectDirectory: absoluteProjectDirectory,
    candidatePath: absoluteCandidate,
  })
  if (worktreeResult instanceof Error) {
    return new Error(
      `Working directory must be inside ${absoluteProjectDirectory} or a git worktree of it: ${absoluteCandidate}`,
      { cause: worktreeResult },
    )
  }

  return { kind: 'worktree', directory: worktreeResult }
}

// Parsed entry from `git worktree list --porcelain`.
// Represents any worktree (kimaki, opencode, manual) visible to git.
export type GitWorktree = {
  directory: string
  branch: string | null // null for detached HEAD
  head: string
  detached: boolean
  locked: boolean
  prunable: boolean
}

type PartialGitWorktree = {
  directory?: string
  branch?: string | null
  head?: string
  detached?: boolean
  locked?: boolean
  prunable?: boolean
}

function flushGitWorktreeEntry(current: PartialGitWorktree): GitWorktree | null {
  if (!current.directory) {
    return null
  }
  return {
    directory: current.directory,
    branch: current.branch ?? null,
    head: current.head ?? '',
    detached: current.detached ?? false,
    locked: current.locked ?? false,
    prunable: current.prunable ?? false,
  }
}

// Parse `git worktree list --porcelain` output into structured entries.
// Skips the first entry (the main checkout) since that's the project root.
export function parseGitWorktreeListPorcelain(output: string): GitWorktree[] {
  const entries: GitWorktree[] = []
  let current: PartialGitWorktree = {}

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      const flushed = flushGitWorktreeEntry(current)
      if (flushed) {
        entries.push(flushed)
      }
      current = { directory: line.slice('worktree '.length) }
      continue
    }
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
      continue
    }
    if (line.startsWith('branch ')) {
      // "branch refs/heads/opencode/kimaki-foo" → "opencode/kimaki-foo"
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      continue
    }
    if (line === 'detached') {
      current.detached = true
      continue
    }
    // "locked" or "locked <reason>"
    if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
      continue
    }
    if (line.startsWith('prunable')) {
      current.prunable = true
      continue
    }
  }
  // Flush last entry
  const flushed = flushGitWorktreeEntry(current)
  if (flushed) {
    entries.push(flushed)
  }

  // Skip the first entry — it's the main checkout (project root)
  return entries.slice(1)
}

// List all git worktrees for a project directory (excluding the main checkout).
// Returns Error on git failure, empty array if no worktrees exist.
export async function listGitWorktrees({
  projectDirectory,
  timeout,
}: {
  projectDirectory: string
  timeout?: number
}): Promise<GitWorktree[] | Error> {
  const result = await git(projectDirectory, 'worktree list --porcelain', {
    timeout,
  })
  if (result instanceof Error) return result
  return parseGitWorktreeListPorcelain(result)
}
