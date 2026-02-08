// Worktree utility functions.
// Wrapper for git worktree creation that initializes and validates submodules.
// Also handles capturing and applying git diffs when creating worktrees from threads.

import crypto from 'node:crypto'
import { exec, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createLogger, LogPrefix } from './logger.js'

const DEFAULT_EXEC_TIMEOUT_MS = 10_000
const SUBMODULE_INIT_TIMEOUT_MS = 20 * 60_000

const _execAsync = promisify(exec)

// Wraps child_process.exec with a default 10s timeout via Promise.race.
// Callers can override with a longer timeout in the options.
export function execAsync(
  command: string,
  options?: Parameters<typeof _execAsync>[1],
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = (options as { timeout?: number })?.timeout || DEFAULT_EXEC_TIMEOUT_MS
  const execPromise = _execAsync(command, options) as Promise<{ stdout: string; stderr: string }> & { child?: import('node:child_process').ChildProcess }
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      execPromise.child?.kill()
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)
  })
  return Promise.race([execPromise, timeoutPromise])
}

const logger = createLogger(LogPrefix.WORKTREE)

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

/**
 * Get submodule paths from .gitmodules file.
 * Returns empty array if no submodules or on error.
 */
async function getSubmodulePaths(directory: string): Promise<string[]> {
  try {
    const result = await execAsync(
      'git config --file .gitmodules --get-regexp path',
      { cwd: directory },
    )
    // Output format: "submodule.name.path value"
    return result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        return line.split(' ')[1]
      })
      .filter((p): p is string => {
        return Boolean(p)
      })
  } catch {
    return [] // No .gitmodules or no submodules
  }
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

      const gitFileExists = await fs.promises.access(submoduleGitFile).then(() => {
        return true
      }).catch(() => {
        return false
      })
      if (!gitFileExists) {
        validationIssues.push(`${submodulePath}: missing .git file`)
        return
      }

      const gitFileContentResult = await errore.tryAsync({
        try: () => fs.promises.readFile(submoduleGitFile, 'utf-8'),
        catch: (e) => new Error(`Failed to read .git for ${submodulePath}`, { cause: e }),
      })
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
      const headExists = await fs.promises.access(headPath).then(() => {
        return true
      }).catch(() => {
        return false
      })
      if (!headExists) {
        validationIssues.push(`${submodulePath}: gitdir missing HEAD (${resolvedGitdir})`)
      }
    }),
  )

  const submoduleStatusResult = await errore.tryAsync({
    try: () => execAsync('git submodule status --recursive', { cwd: directory, timeout: SUBMODULE_INIT_TIMEOUT_MS }),
    catch: (e) => new Error('git submodule status --recursive failed', { cause: e }),
  })
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
  const remoteHead = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', {
    cwd: directory,
  }).catch(() => {
    return null
  })

  const remoteRef = remoteHead?.stdout.trim()
  if (remoteRef?.startsWith('refs/remotes/')) {
    return remoteRef.replace('refs/remotes/', '')
  }

  const hasMain = await execAsync('git show-ref --verify --quiet refs/heads/main', {
    cwd: directory,
  }).then(() => {
    return true
  }).catch(() => {
    return false
  })
  if (hasMain) {
    return 'main'
  }

  const hasMaster = await execAsync('git show-ref --verify --quiet refs/heads/master', {
    cwd: directory,
  }).then(() => {
    return true
  }).catch(() => {
    return false
  })
  if (hasMaster) {
    return 'master'
  }

  return 'HEAD'
}

function getManagedWorktreeDirectory({ directory, name }: { directory: string; name: string }): string {
  const projectHash = crypto.createHash('sha1').update(directory).digest('hex')
  const safeName = name.replaceAll('/', '-')
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'worktree', projectHash, safeName)
}

/**
 * Create a worktree using git and initialize git submodules.
 * This wrapper ensures submodules are properly set up in new worktrees.
 *
 * If diff is provided, it's applied BEFORE submodule update to ensure
 * any submodule pointer changes in the diff are respected.
 */
export async function createWorktreeWithSubmodules({
  directory,
  name,
  diff,
}: {
  directory: string
  name: string
  diff?: CapturedDiff | null
}): Promise<WorktreeResult & { diffApplied: boolean } | Error> {
  // 1. Create worktree via git (checked out immediately).
  const worktreeDir = getManagedWorktreeDirectory({ directory, name })
  const targetRef = await resolveDefaultWorktreeTarget(directory)

  if (fs.existsSync(worktreeDir)) {
    return new Error(`Worktree directory already exists: ${worktreeDir}`)
  }

  await fs.promises.mkdir(path.dirname(worktreeDir), { recursive: true })

  const createCommand = `git worktree add ${JSON.stringify(worktreeDir)} -B ${JSON.stringify(name)} ${JSON.stringify(targetRef)}`
  const createResult = await errore.tryAsync({
    try: () => execAsync(createCommand, { cwd: directory, timeout: SUBMODULE_INIT_TIMEOUT_MS }),
    catch: (e) => new Error(`git worktree add failed: ${formatCommandError(e)}`, { cause: e }),
  })
  if (createResult instanceof Error) {
    return createResult
  }

  let diffApplied = false

  // 2. Apply diff BEFORE submodule update (if provided)
  // This ensures any submodule pointer changes in the diff are applied first,
  // so submodule update checks out the correct commits.
  if (diff) {
    logger.log(`Applying diff to ${worktreeDir} before submodule init`)
    diffApplied = await applyGitDiff(worktreeDir, diff)
  }

  // 3. Remove broken submodule stubs before init
  // git worktree creates stub directories with .git files pointing to incomplete gitdirs
  await removeBrokenSubmoduleStubs(worktreeDir)

  // 4. Init submodules in new worktree
  // Uses --init to initialize, --recursive for nested submodules.
  // Submodules will be checked out at the commit specified by the (possibly updated) index.
  try {
    logger.log(`Initializing submodules in ${worktreeDir} (timeout=${SUBMODULE_INIT_TIMEOUT_MS}ms)`)
    await execAsync('git submodule update --init --recursive', {
      cwd: worktreeDir,
      timeout: SUBMODULE_INIT_TIMEOUT_MS,
    })
    logger.log(`Submodules initialized in ${worktreeDir}`)
  } catch (e) {
    const errorMessage = formatCommandError(e)
    logger.error('Submodule initialization failed', {
      worktreeDir,
      timeoutMs: SUBMODULE_INIT_TIMEOUT_MS,
      command: 'git submodule update --init --recursive',
      error: errorMessage,
    })
    return new Error(`Submodule initialization failed: ${errorMessage}`)
  }

  // 4.5 Validate submodule pointers and git metadata before marking ready.
  const submoduleValidationError = await validateSubmodulePointers(worktreeDir)
  if (submoduleValidationError instanceof Error) {
    logger.error('Submodule validation failed after init', {
      worktreeDir,
      error: submoduleValidationError.message,
    })
    return submoduleValidationError
  }

  // 5. Install dependencies using ni (detects package manager from lockfile)
  try {
    logger.log(`Installing dependencies in ${worktreeDir}`)
    await execAsync('npx -y ni', {
      cwd: worktreeDir,
    })
    logger.log(`Dependencies installed in ${worktreeDir}`)
  } catch (e) {
    // Log but don't fail - might not be a JS project or might fail for various reasons
    logger.warn(
      `Failed to install dependencies in ${worktreeDir}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  return { directory: worktreeDir, branch: name, diffApplied }
}

/**
 * Captured git diff (both staged and unstaged changes).
 */
export type CapturedDiff = {
  unstaged: string
  staged: string
}

/**
 * Capture git diff from a directory (both staged and unstaged changes).
 * Returns null if no changes or on error.
 */
export async function captureGitDiff(directory: string): Promise<CapturedDiff | null> {
  try {
    // Capture unstaged changes
    const unstagedResult = await execAsync('git diff', { cwd: directory })
    const unstaged = unstagedResult.stdout.trim()

    // Capture staged changes
    const stagedResult = await execAsync('git diff --staged', { cwd: directory })
    const staged = stagedResult.stdout.trim()

    if (!unstaged && !staged) {
      return null
    }

    return { unstaged, staged }
  } catch (e) {
    logger.warn(`Failed to capture git diff from ${directory}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * Run a git command with stdin input.
 * Uses spawn to pipe the diff content to git apply.
 */
function runGitWithStdin(args: string[], cwd: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })

    let stderr = ''
    child.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderr || `git ${args.join(' ')} failed with code ${code}`))
      }
    })

    child.on('error', reject)

    child.stdin?.write(input)
    child.stdin?.end()
  })
}

/**
 * Apply a captured git diff to a directory.
 * Applies staged changes first, then unstaged.
 */
export async function applyGitDiff(directory: string, diff: CapturedDiff): Promise<boolean> {
  try {
    // Apply staged changes first (and stage them)
    if (diff.staged) {
      logger.log(`Applying staged diff to ${directory}`)
      await runGitWithStdin(['apply', '--index'], directory, diff.staged)
    }

    // Apply unstaged changes (don't stage them)
    if (diff.unstaged) {
      logger.log(`Applying unstaged diff to ${directory}`)
      await runGitWithStdin(['apply'], directory, diff.unstaged)
    }

    logger.log(`Successfully applied diff to ${directory}`)
    return true
  } catch (e) {
    logger.warn(`Failed to apply git diff to ${directory}: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

// ─── Worktree merge ──────────────────────────────────────────────────────────
// Implements a worktrunk-style merge pipeline:
//   1. Reject if uncommitted changes exist
//   2. Squash all commits since merge-base into one
//   3. Rebase onto target (default branch)
//   4. Fast-forward push to target via local git push
//   5. Switch to detached HEAD, delete branch
//
// Uses `git push <git-common-dir> HEAD:<target>` with
// `receive.denyCurrentBranch=updateInstead` to fast-forward the target
// WITHOUT checking it out in the main repo.
//
// Returns MergeWorktreeErrors | MergeSuccess. All errors are tagged via errore.
// - DirtyWorktreeError         → git untouched
// - NothingToMergeError        → git untouched
// - SquashError                → HEAD may be at merge-base with staged changes
// - RebaseConflictError        → git left mid-rebase for AI/user resolution
// - RebaseError                → rebase not in progress; temp branch cleaned
// - NotFastForwardError        → source intact; no push
// - ConflictingFilesError      → no push; lists overlapping files
// - PushError                  → source rebased but target unchanged
// - GitCommandError            → catch-all for unexpected git failures

import * as errore from 'errore'
import {
  DirtyWorktreeError,
  NothingToMergeError,
  SquashError,
  RebaseConflictError,
  RebaseError,
  NotFastForwardError,
  ConflictingFilesError,
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

async function git(dir: string, args: string, opts?: { timeout?: number }): Promise<GitCommandError | string> {
  const result = await errore.tryAsync({
    try: () => execAsync(`git -C "${dir}" ${args}`, opts ? { timeout: opts.timeout } : undefined),
    catch: (e) => new GitCommandError({ command: args, cause: e }),
  })
  if (result instanceof Error) {
    return result
  }
  return result.stdout.trim()
}

async function getDefaultBranch(repoDir: string): Promise<string> {
  const ref = await git(repoDir, 'symbolic-ref refs/remotes/origin/HEAD')
  if (ref instanceof Error) {
    return 'main'
  }
  return ref.replace(/^refs\/remotes\/origin\//, '') || 'main'
}

async function isDirty(dir: string): Promise<boolean> {
  const status = await git(dir, 'status --porcelain')
  if (status instanceof Error) {
    return false
  }
  return status.length > 0
}

async function getGitCommonDir(dir: string): Promise<GitCommandError | string> {
  const commonDir = await git(dir, 'rev-parse --git-common-dir')
  if (commonDir instanceof Error) {
    return commonDir
  }
  if (path.isAbsolute(commonDir)) {
    return commonDir
  }
  return path.resolve(dir, commonDir)
}

async function isAncestor(dir: string, ref1: string, ref2: string): Promise<boolean> {
  const result = await git(dir, `merge-base --is-ancestor "${ref1}" "${ref2}"`)
  return !(result instanceof Error)
}

async function isRebasedOnto(dir: string, target: string): Promise<boolean> {
  const mergeBase = await git(dir, `merge-base HEAD "${target}"`)
  if (mergeBase instanceof Error) {
    return false
  }
  const targetSha = await git(dir, `rev-parse "${target}"`)
  if (targetSha instanceof Error) {
    return false
  }
  return mergeBase === targetSha
}

async function getChangedFiles(dir: string, ref1: string, ref2: string): Promise<string[]> {
  const result = await git(dir, `diff --name-only "${ref1}" "${ref2}"`)
  if (result instanceof Error) {
    return []
  }
  return result.split('\n').filter(Boolean)
}

/**
 * Get dirty files using porcelain -z format.
 * Handles rename/copy entries which emit two NUL-separated paths.
 */
async function getDirtyFiles(dir: string): Promise<string[]> {
  const result = await git(dir, 'status --porcelain -z')
  if (result instanceof Error) {
    return []
  }
  const files: string[] = []
  const parts = result.split('\0')
  let i = 0
  while (i < parts.length) {
    const entry = parts[i]
    if (!entry || entry.length < 3) {
      i++
      continue
    }
    const status = entry.slice(0, 2)
    const filePath = entry.slice(3)
    if (filePath) {
      files.push(filePath)
    }
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
      i++
      const oldPath = parts[i]
      if (oldPath) {
        files.push(oldPath)
      }
    }
    i++
  }
  return files
}

/**
 * Check if target worktree has dirty files overlapping with the push range.
 * updateInstead only rejects overlapping files; non-overlapping dirty files
 * are left untouched.
 */
async function checkTargetWorktreeConflicts({ targetDir, sourceDir, targetBranch }: {
  targetDir: string
  sourceDir: string
  targetBranch: string
}): Promise<string[] | null> {
  if (!await isDirty(targetDir)) {
    return null
  }
  const pushFiles = await getChangedFiles(sourceDir, targetBranch, 'HEAD')
  const dirtyFiles = await getDirtyFiles(targetDir)
  const overlapping = pushFiles.filter((f) => {
    return dirtyFiles.includes(f)
  })
  return overlapping.length > 0 ? overlapping : null
}

/**
 * Check if git is mid-rebase by looking for rebase-merge or rebase-apply dirs.
 */
async function isRebaseInProgress(dir: string): Promise<boolean> {
  for (const rebaseDir of ['rebase-merge', 'rebase-apply']) {
    const gitPath = await git(dir, `rev-parse --git-path ${rebaseDir}`)
    if (gitPath instanceof Error) {
      continue
    }
    const resolvedPath = path.isAbsolute(gitPath) ? gitPath : path.resolve(dir, gitPath)
    const exists = await fs.promises.access(resolvedPath).then(() => {
      return true
    }).catch(() => {
      return false
    })
    if (exists) {
      return true
    }
  }
  return false
}

export function buildSquashMessage({ branchName, commitMessages }: {
  branchName: string
  commitMessages: string[]
}): string {
  const lines: string[] = [`worktree merge: ${branchName}`]
  if (commitMessages.length > 0) {
    lines.push('')
    for (const message of commitMessages) {
      const msgLines = message.split('\n')
      lines.push(`- ${msgLines[0]}`)
      for (const extra of msgLines.slice(1)) {
        lines.push(`  ${extra}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * Merge a worktree branch into the default branch using worktrunk-style pipeline.
 * Returns MergeWorktreeErrors | MergeSuccess.
 */
export async function mergeWorktree({ worktreeDir, mainRepoDir, worktreeName, onProgress }: {
  worktreeDir: string
  mainRepoDir: string
  worktreeName: string
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
    if (createResult instanceof Error) {
      return createResult
    }
    branchName = tempBranch
  } else {
    branchName = branchResult || worktreeName
  }

  const defaultBranch = await getDefaultBranch(mainRepoDir)
  log(`Merging ${branchName} into ${defaultBranch}`)

  // Best-effort cleanup of temp branch on error paths
  const cleanupTempBranch = async () => {
    if (!tempBranch) {
      return
    }
    await git(worktreeDir, 'checkout --detach')
    await git(worktreeDir, `branch -D "${tempBranch}"`)
  }

  // ── Step 1: Reject uncommitted changes ──
  if (await isDirty(worktreeDir)) {
    await cleanupTempBranch()
    return new DirtyWorktreeError()
  }

  // ── Step 2: Squash + Step 3: Rebase ──
  // If already rebased onto target, skip squash+rebase entirely.
  // This happens on retry after the model resolved a rebase conflict --
  // the previous run already squashed, and the model completed the rebase.
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
    // Squash into single commit with full commit messages
    log(commitCount > 1 ? `Squashing ${commitCount} commits...` : 'Preparing merge commit...')

    const SEP = '---KIMAKI-COMMIT-SEP---'
    const logRange = `${mergeBase}..HEAD`
    const messagesResult = await git(worktreeDir, `log --format="%B${SEP}" --reverse "${logRange}"`)
    if (messagesResult instanceof Error) {
      await cleanupTempBranch()
      return new SquashError({ reason: 'Failed to read commit messages', cause: messagesResult })
    }

    const commitMessages = messagesResult.split(SEP).map((m) => {
      return m.trim()
    }).filter(Boolean)

    const squashMessage = buildSquashMessage({ branchName: worktreeName || branchName, commitMessages })

    const resetResult = await git(worktreeDir, `reset --soft "${mergeBase}"`)
    if (resetResult instanceof Error) {
      await cleanupTempBranch()
      return new SquashError({ reason: 'git reset --soft failed', cause: resetResult })
    }

    const commitResult = await errore.tryAsync({
      try: () => runGitWithStdin(['commit', '-m', squashMessage, '--'], worktreeDir, ''),
      catch: (e) => new SquashError({ reason: 'git commit failed after reset', cause: e }),
    })
    if (commitResult instanceof Error) {
      await cleanupTempBranch()
      return commitResult
    }

    // Rebase onto target
    log(`Rebasing onto ${defaultBranch}...`)
    const rebaseResult = await git(worktreeDir, `rebase "${defaultBranch}"`, { timeout: 60_000 })
    if (rebaseResult instanceof Error) {
      if (await isRebaseInProgress(worktreeDir)) {
        return new RebaseConflictError({ target: defaultBranch, cause: rebaseResult })
      }
      await cleanupTempBranch()
      return new RebaseError({ target: defaultBranch, cause: rebaseResult })
    }
  } else {
    log('Already rebased onto target')
  }

  // ── Step 4: Fast-forward push via local git push ──
  if (!await isAncestor(worktreeDir, defaultBranch, 'HEAD')) {
    await cleanupTempBranch()
    return new NotFastForwardError({ target: defaultBranch })
  }

  const overlappingFiles = await checkTargetWorktreeConflicts({
    targetDir: mainRepoDir,
    sourceDir: worktreeDir,
    targetBranch: defaultBranch,
  })
  if (overlappingFiles) {
    await cleanupTempBranch()
    return new ConflictingFilesError({ target: defaultBranch })
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
  await git(worktreeDir, `checkout --detach "${defaultBranch}"`)
  await git(worktreeDir, `branch -D "${branchName}"`)
  if (branchName !== worktreeName && worktreeName) {
    await git(worktreeDir, `branch -D "${worktreeName}"`)
  }

  return {
    defaultBranch,
    branchName: worktreeName || branchName,
    commitCount,
    shortSha: shortSha instanceof Error ? 'unknown' : shortSha,
  }
}
