// Worktree service and git helpers.
// Provides managed paths, merge logic, and git diff transfer utilities.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'
import { execAsync } from './exec-async.js'
import { createLogger, LogPrefix } from './logger.js'

export { execAsync } from './exec-async.js'

const SUBMODULE_INIT_TIMEOUT_MS = 20 * 60_000
const logger = createLogger(LogPrefix.WORKTREE)

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
  const projectHash = crypto
    .createHash('sha1')
    .update(directory)
    .digest('hex')
    .slice(0, 8)
  const withoutPrefix = name
    .replace(/^opencode\/kimaki-/, '')
    .replaceAll('/', '-')
  return path.join(getDataDir(), 'worktrees', projectHash, withoutPrefix)
}

// ─── Worktree merge ──────────────────────────────────────────────────────────
// Merge pipeline:
//   1. Reject if uncommitted changes exist
//   2. Rebase worktree commits onto target (default branch)
//   3. Optionally collapse the rebased tree into one commit
//   4. Fast-forward push to target via local git push
//   5. Switch to detached HEAD, delete branch
//
// Uses `git push <git-common-dir> <merge-ref>:<target>` with
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

export type MergeStrategy = 'rebase' | 'squash'

export async function git(
  dir: string,
  args: string | string[],
  opts?: { timeout?: number },
): Promise<GitCommandError | string> {
  const command = Array.isArray(args)
    ? { command: 'git', args: ['-C', dir, ...args] }
    : `git -C "${dir}" ${args}`
  const commandLabel = Array.isArray(args)
    ? ['git', '-C', dir, ...args].join(' ')
    : `git -C "${dir}" ${args}`
  const result = await execAsync(
    command,
    opts ? { timeout: opts.timeout } : undefined,
  ).catch((e) => new GitCommandError({ command: commandLabel, cause: e }))
  if (result instanceof Error) return result
  return result.stdout.trim()
}

function walkErrorCauseChain(error: Error): Error[] {
  const seen = new Set<Error>()
  const chain: Error[] = []
  let current: unknown = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = current.cause
  }
  return chain
}

function execTextField(error: Error, field: 'stderr' | 'stdout'): string {
  const value = Reflect.get(error, field)
  if (typeof value === 'string') return value.trim()
  if (value instanceof Uint8Array) return new TextDecoder().decode(value).trim()
  return ''
}

function execExitCode(error: Error): string | undefined {
  const code = Reflect.get(error, 'code')
  if (typeof code === 'string' || typeof code === 'number') return String(code)
  return undefined
}

export type GitExecOutput = {
  command: string | undefined
  stderr: string
  stdout: string
  code: string | undefined
}

export function extractGitExecOutput(error: Error): GitExecOutput {
  const chain = walkErrorCauseChain(error)
  const gitErr = chain.find((item) => item instanceof GitCommandError)
  let stderr = ''
  let stdout = ''
  let code: string | undefined
  for (const item of chain) {
    if (!stderr) stderr = execTextField(item, 'stderr')
    if (!stdout) stdout = execTextField(item, 'stdout')
    if (code === undefined) code = execExitCode(item)
  }
  const command = gitErr instanceof GitCommandError ? gitErr.command : undefined
  return {
    command: typeof command === 'string' ? command : undefined,
    stderr,
    stdout,
    code,
  }
}

function isRedundantCauseMessage({
  message,
  headline,
  command,
  output,
}: {
  message: string
  headline: string
  command: string | undefined
  output: string
}): boolean {
  if (!message) return true
  if (message === headline) return true
  if (command && message === `Git command failed: ${command}`) return true
  if (message.startsWith('Command failed:')) return true
  if (output && message.includes(output)) return true
  return false
}

function truncateFormattedError(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const ellipsis = '\n… [truncated]'
  return text.slice(0, Math.max(0, maxLength - ellipsis.length)) + ellipsis
}

export function formatMergeWorktreeError(
  error: Error,
  opts?: { maxLength?: number },
): string {
  const maxLength = opts?.maxLength ?? 1900
  const output = extractGitExecOutput(error)
  const lines: string[] = [`Merge failed: ${error.message}`]
  if (error instanceof PushError) {
    lines.push(
      'Worktree rebase succeeded. Local branch was not updated. This is not a push to origin.',
    )
  }

  const extraCauses = walkErrorCauseChain(error)
    .slice(1)
    .map((item) => item.message)
    .filter((message) => {
      return !isRedundantCauseMessage({
        message,
        headline: error.message,
        command: output.command,
        output: [output.stderr, output.stdout].filter(Boolean).join('\n'),
      })
    })

  const blockLines: string[] = []
  if (output.command) blockLines.push(output.command)
  if (output.code) blockLines.push(`exit ${output.code}`)
  if (output.stderr) {
    if (blockLines.length) blockLines.push('')
    blockLines.push(output.stderr)
  }
  if (output.stdout && output.stdout !== output.stderr) {
    if (blockLines.length) blockLines.push('')
    blockLines.push(output.stdout)
  }
  for (const message of extraCauses) {
    if (blockLines.length) blockLines.push('')
    blockLines.push(message)
  }
  if (blockLines.length > 0) {
    lines.push('', '```', ...blockLines, '```')
  }
  return truncateFormattedError(lines.join('\n'), maxLength)
}

export async function getDefaultBranch(
  repoDir: string,
  opts?: { timeout?: number },
): Promise<string> {
  const ref = await git(repoDir, ['symbolic-ref', 'refs/remotes/origin/HEAD'], opts)
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
    const stderr =
      (removeResult.cause as { stderr?: string } | undefined)?.stderr ?? ''
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

export async function isDirty(
  dir: string,
  opts?: { timeout?: number },
): Promise<GitCommandError | boolean> {
  const status = await git(dir, ['status', '--porcelain'], opts)
  if (status instanceof Error) return status
  return status.length > 0
}

export async function isGitRepositoryRoot(directory: string): Promise<boolean> {
  const topLevel = await git(directory, 'rev-parse --show-toplevel')
  if (topLevel instanceof Error) return false
  return path.resolve(topLevel) === path.resolve(directory)
}

async function getGitCommonDir(dir: string): Promise<GitCommandError | string> {
  const commonDir = await git(dir, ['rev-parse', '--git-common-dir'])
  if (commonDir instanceof Error) return commonDir
  if (path.isAbsolute(commonDir)) {
    return commonDir
  }
  return path.resolve(dir, commonDir)
}

async function isAncestor(
  {
    dir,
    ref1,
    ref2,
  }: {
    dir: string
    ref1: string
    ref2: string
  },
): Promise<boolean> {
  const result = await git(dir, ['merge-base', '--is-ancestor', ref1, ref2])
  return !(result instanceof Error)
}

async function isRebasedOnto(dir: string, target: string): Promise<boolean> {
  const mergeBase = await git(dir, ['merge-base', 'HEAD', target])
  if (mergeBase instanceof Error) return false
  const targetSha = await git(dir, ['rev-parse', target])
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
}): Promise<GitCommandError | boolean> {
  const currentBranch = await git(targetDir, ['symbolic-ref', '--short', 'HEAD'])
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
    const gitPath = await git(dir, ['rev-parse', '--git-path', rebaseDir])
    if (gitPath instanceof Error) continue
    const resolvedPath = path.isAbsolute(gitPath)
      ? gitPath
      : path.resolve(dir, gitPath)
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

async function createSquashCommit({
  worktreeDir,
  target,
  branchName,
}: {
  worktreeDir: string
  target: string
  branchName: string
}) {
  const tree = await git(worktreeDir, ['rev-parse', 'HEAD^{tree}'])
  if (tree instanceof Error) return tree
  const parent = await git(worktreeDir, ['rev-parse', `${target}^{commit}`])
  if (parent instanceof Error) return parent
  return git(worktreeDir, [
    'commit-tree',
    tree,
    '-p',
    parent,
    '-m',
    `Merge worktree ${branchName}`,
  ])
}

/**
 * Merge a worktree branch into the default branch by rebasing all commits,
 * optionally squashing them, then fast-forward pushing.
 * Returns MergeWorktreeErrors | MergeSuccess.
 */
export async function mergeWorktree({
  worktreeDir,
  mainRepoDir,
  worktreeName,
  targetBranch,
  strategy = 'rebase',
  onProgress,
}: {
  worktreeDir: string
  mainRepoDir: string
  worktreeName: string
  /** Override the branch to merge into. Defaults to origin/HEAD (or main). */
  targetBranch?: string
  strategy?: MergeStrategy
  onProgress?: (message: string) => void
}): Promise<MergeWorktreeErrors | MergeSuccess> {
  const log = (msg: string) => {
    logger.log(msg)
    onProgress?.(msg)
  }

  const requestedTarget = targetBranch || (await getDefaultBranch(mainRepoDir))
  const validatedTarget = await validateBranchRef({
    directory: mainRepoDir,
    ref: requestedTarget,
  })
  if (validatedTarget instanceof Error) {
    return new GitCommandError({
      command: `validate merge target ${requestedTarget}`,
      cause: validatedTarget,
    })
  }
  const defaultBranch = validatedTarget

  // A paused rebase has a detached HEAD, so detect it before creating a temp branch.
  if (await isRebaseInProgress(worktreeDir)) {
    return new RebaseConflictError({ target: defaultBranch })
  }

  // Resolve current branch. If detached, create a temp branch.
  let branchName: string
  let tempBranch: string | null = null
  const branchResult = await git(worktreeDir, ['symbolic-ref', '--short', 'HEAD'])
  if (branchResult instanceof Error) {
    tempBranch = `kimaki-merge-${Date.now()}`
    const createResult = await git(worktreeDir, ['checkout', '-b', tempBranch])
    if (createResult instanceof Error) return createResult
    branchName = tempBranch
  } else {
    branchName = branchResult || worktreeName
  }

  log(`Merging ${branchName} into ${defaultBranch}`)

  // Best-effort cleanup of temp branch on error paths
  const cleanupTempBranch = async () => {
    if (!tempBranch) {
      return
    }

    const detachResult = await git(worktreeDir, ['checkout', '--detach'])
    if (detachResult instanceof Error) {
      logger.warn(
        `[MERGE CLEANUP] Failed to detach HEAD before deleting temp branch: ${detachResult.message}`,
      )
    }

    const deleteTempBranchResult = await git(worktreeDir, [
      'branch',
      '-D',
      tempBranch,
    ])
    if (deleteTempBranchResult instanceof Error) {
      logger.warn(
        `[MERGE CLEANUP] Failed to delete temp branch ${tempBranch}: ${deleteTempBranchResult.message}`,
      )
    }
  }

  // ── Step 1: Reject uncommitted changes ──
  const worktreeDirty = await isDirty(worktreeDir)
  if (worktreeDirty instanceof Error) {
    await cleanupTempBranch()
    return worktreeDirty
  }
  if (worktreeDirty) {
    await cleanupTempBranch()
    return new DirtyWorktreeError()
  }

  // ── Step 2: Rebase worktree commits onto target ──
  // If already rebased onto target AND no rebase is in progress, skip
  // rebase entirely. The in-progress check above guarantees the second
  // half; we keep it implicit here.
  const alreadyRebased = await isRebasedOnto(worktreeDir, defaultBranch)

  const mergeBaseResult = await git(worktreeDir, [
    'merge-base',
    'HEAD',
    defaultBranch,
  ])
  const mergeBase =
    mergeBaseResult instanceof Error ? defaultBranch : mergeBaseResult

  const commitCountResult = await git(worktreeDir, [
    'rev-list',
    '--count',
    `${mergeBase}..HEAD`,
  ])
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
    const rebaseResult = await git(worktreeDir, ['rebase', defaultBranch], {
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

  // ── Step 3: Optionally create one commit for the complete rebased tree ──
  const mergeRef = strategy === 'squash'
    ? await createSquashCommit({
        worktreeDir,
        target: defaultBranch,
        branchName,
      })
    : 'HEAD'
  if (mergeRef instanceof Error) {
    await cleanupTempBranch()
    return mergeRef
  }
  if (strategy === 'squash') {
    log(`Squashing ${commitCount} commit${commitCount === 1 ? '' : 's'}...`)
  }

  // ── Step 4: Fast-forward push via local git push ──
  if (!(await isAncestor({ dir: worktreeDir, ref1: defaultBranch, ref2: mergeRef }))) {
    await cleanupTempBranch()
    return new NotFastForwardError({ target: defaultBranch })
  }

  const targetIsDirty = await isCheckedOutTargetDirty({
    targetDir: mainRepoDir,
    targetBranch: defaultBranch,
  })
  if (targetIsDirty instanceof Error) {
    await cleanupTempBranch()
    return targetIsDirty
  }
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
  const pushResult = await git(worktreeDir, [
    'push',
    '--receive-pack=git -c receive.denyCurrentBranch=updateInstead receive-pack',
    gitCommonDir,
    `${mergeRef}:${defaultBranch}`,
  ], { timeout: 30_000 })
  if (pushResult instanceof Error) {
    await cleanupTempBranch()
    return new PushError({ target: defaultBranch, cause: pushResult })
  }

  // Get short SHA for display
  const shortSha = await git(worktreeDir, ['rev-parse', '--short', mergeRef])
  if (shortSha instanceof Error) {
    // Push succeeded but can't get SHA -- non-fatal, use placeholder
    logger.warn('Failed to get short SHA after push')
  }

  // ── Step 5: Clean up -- detach HEAD and delete branch ──
  log('Cleaning up worktree...')
  const detachResult = await git(worktreeDir, [
    'checkout',
    '--detach',
    defaultBranch,
  ])
  if (detachResult instanceof Error) {
    logger.warn(
      `[MERGE CLEANUP] Failed to detach worktree HEAD after push: ${detachResult.message}`,
    )
  }

  const deleteBranchResult = await git(worktreeDir, ['branch', '-D', branchName])
  if (deleteBranchResult instanceof Error) {
    logger.warn(
      `[MERGE CLEANUP] Failed to delete branch ${branchName}: ${deleteBranchResult.message}`,
    )
  }

  return {
    defaultBranch,
    branchName: worktreeName || branchName,
    commitCount,
    shortSha: shortSha instanceof Error ? 'unknown' : shortSha,
  }
}

/**
 * Resolve the best git ref for a base branch by checking remote tracking refs.
 * Prefers upstream/<branch> over origin/<branch> over local <branch>.
 * Fetches the remote first so tracking refs are up to date.
 *
 * If the remote is strictly ahead of local, returns the remote ref.
 * If local and remote have diverged (local is both ahead and behind),
 * returns the local branch to avoid needing a merge/rebase.
 * If the branch is already an explicit remote ref (e.g. `origin/main`), skips resolution.
 * Uses `git remote` to distinguish real remote prefixes from local branches
 * containing `/` like `feature/foo`.
 */
export async function resolveBestBaseRef({
  directory,
  branch,
}: {
  directory: string
  branch: string
}): Promise<string> {
  // Check if branch is already an explicit remote ref like "origin/main".
  // Local branches can contain `/` (e.g. "feature/foo"), so we check
  // against actual remote names instead of a naive slash check.
  if (branch.includes('/')) {
    const remotes = await git(directory, 'remote')
    if (!(remotes instanceof Error)) {
      const prefix = branch.slice(0, branch.indexOf('/'))
      if (remotes.split('\n').some((r) => r.trim() === prefix)) {
        return branch
      }
    }
  }

  for (const remote of ['upstream', 'origin']) {
    // Best-effort fetch with short timeout
    const fetchResult = await git(directory, `fetch ${remote} ${branch}`, {
      timeout: 15_000,
    })
    if (fetchResult instanceof Error) continue

    const remoteRef = `${remote}/${branch}`
    const refExists = await git(directory, `rev-parse --verify refs/remotes/${remoteRef}`)
    if (refExists instanceof Error) continue

    // Check if local branch exists
    const localExists = await git(directory, `rev-parse --verify refs/heads/${branch}`)
    if (localExists instanceof Error) {
      // No local branch but remote exists — use remote
      return remoteRef
    }

    // Count commits: remote ahead of local, and local ahead of remote
    const [remoteAhead, localAhead] = await Promise.all([
      git(directory, `rev-list --count refs/heads/${branch}..refs/remotes/${remoteRef}`),
      git(directory, `rev-list --count refs/remotes/${remoteRef}..refs/heads/${branch}`),
    ])
    if (remoteAhead instanceof Error || localAhead instanceof Error) continue

    const remoteAheadCount = parseInt(remoteAhead, 10)
    const localAheadCount = parseInt(localAhead, 10)

    // Diverged (both ahead): use local to avoid needing a merge
    if (remoteAheadCount > 0 && localAheadCount > 0) return branch

    // Remote is strictly ahead: use remote ref
    if (remoteAheadCount > 0) return remoteRef

    // Equal or local is ahead — check next remote instead of returning early,
    // because origin might be ahead even when upstream is equal.
  }

  // No usable remote found — use local branch as-is
  return branch
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
  const result = await git(directory, ['check-ref-format', '--branch', ref])
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
    return new Error(
      `Directory is not a git worktree of ${projectDirectory}: ${absoluteCandidate}`,
    )
  }

  return absoluteCandidate
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
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  )
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
export function parseGitWorktreeListPorcelain(
  output: string,
): GitWorktree[] {
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
