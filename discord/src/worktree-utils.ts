// Worktree utility functions.
// Wrapper for OpenCode worktree creation that also initializes git submodules.
// Also handles capturing and applying git diffs when creating worktrees from threads.

import { exec, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { createLogger, LogPrefix } from './logger.js'
import type { getOpencodeClientV2 } from './opencode.js'

const DEFAULT_EXEC_TIMEOUT_MS = 10_000

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

type OpencodeClientV2 = NonNullable<ReturnType<typeof getOpencodeClientV2>>

type WorktreeResult = {
  directory: string
  branch: string
}

/**
 * Create a worktree using OpenCode SDK and initialize git submodules.
 * This wrapper ensures submodules are properly set up in new worktrees.
 *
 * If diff is provided, it's applied BEFORE submodule update to ensure
 * any submodule pointer changes in the diff are respected.
 */
export async function createWorktreeWithSubmodules({
  clientV2,
  directory,
  name,
  diff,
}: {
  clientV2: OpencodeClientV2
  directory: string
  name: string
  diff?: CapturedDiff | null
}): Promise<WorktreeResult & { diffApplied: boolean } | Error> {
  // 1. Create worktree via OpenCode SDK
  const response = await clientV2.worktree.create({
    directory,
    worktreeCreateInput: { name },
  })

  if (response.error) {
    return new Error(`SDK error: ${JSON.stringify(response.error)}`)
  }

  if (!response.data) {
    return new Error('No worktree data returned from SDK')
  }

  const worktreeDir = response.data.directory
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

  // 4. Init submodules in new worktree (don't block on failure)
  // Uses --init to initialize, --recursive for nested submodules.
  // Submodules will be checked out at the commit specified by the (possibly updated) index.
  try {
    logger.log(`Initializing submodules in ${worktreeDir}`)
    await execAsync('git submodule update --init --recursive', {
      cwd: worktreeDir,
    })
    logger.log(`Submodules initialized in ${worktreeDir}`)
  } catch (e) {
    // Log but don't fail - submodules might not exist
    logger.warn(
      `Failed to init submodules in ${worktreeDir}: ${e instanceof Error ? e.message : String(e)}`,
    )
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

  return { ...response.data, diffApplied }
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
// Failure modes (all return { success: false } unless noted):
//
// Pre-merge checks:
// - Dirty worktree              → error; git untouched
// - No common ancestor          → falls back to defaultBranch as base; may squash too much
// - Zero commits ahead          → error "already up to date"; git untouched
//
// Squash (git reset --soft + commit):
// - reset --soft fails           → error; git untouched (pre-squash state)
// - commit fails after reset     → error; HEAD at merge-base, changes staged but uncommitted
//   Recovery: `git commit` manually or `git reset HEAD@{1}` to restore
//
// Rebase:
// - Conflict (rebase-merge/apply dir exists) → returns conflictType:'rebase';
//   git left mid-rebase intentionally for AI/user resolution
// - Non-conflict failure (timeout/perms)     → error; rebase not in progress; temp branch cleaned
//
// Push:
// - Target has newer commits (not fast-forward) → error; source branch intact; no push
// - Target worktree has overlapping dirty files → error; no push
// - receive-pack/permission/timeout failure     → error; source rebased but target unchanged
// - Push succeeds but post-push cleanup fails   → target advanced; worktree may still be
//   on branch instead of detached; branch may linger (cleanup errors are swallowed)
//
// Temp branch (detached HEAD case):
// - Created on entry if detached; cleaned up on all error paths via cleanupTempBranch()
// - Cleanup errors are swallowed (best-effort)
//
// Default branch detection:
// - Uses origin/HEAD, falls back to 'main'; if wrong, merges into wrong branch
// - No validation that the branch exists locally

export type MergeWorktreeResult = {
  success: true
  defaultBranch: string
  branchName: string
  commitCount: number
  shortSha: string
} | {
  success: false
  error: string
  /** When set, the rebase has conflicts that the AI agent can resolve */
  conflictType?: 'rebase'
}

/**
 * Get the default branch name for a repository.
 * Tries origin/HEAD first, falls back to 'main'.
 */
async function getDefaultBranch(repoDir: string): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `git -C "${repoDir}" symbolic-ref refs/remotes/origin/HEAD`,
    )
    const ref = stdout.trim()
    // refs/remotes/origin/main -> main
    const branch = ref.replace(/^refs\/remotes\/origin\//, '')
    return branch || 'main'
  } catch {
    return 'main'
  }
}

/**
 * Check if a worktree has uncommitted changes (staged or unstaged or untracked).
 */
async function isDirty(dir: string): Promise<boolean> {
  const { stdout } = await execAsync(`git -C "${dir}" status --porcelain`)
  return stdout.trim().length > 0
}

/**
 * Get the git common dir (shared .git directory across all worktrees).
 * This is the directory used for local push to fast-forward the target.
 */
async function getGitCommonDir(dir: string): Promise<string> {
  const { stdout } = await execAsync(`git -C "${dir}" rev-parse --git-common-dir`)
  const commonDir = stdout.trim()
  // git returns relative path, resolve it
  if (path.isAbsolute(commonDir)) {
    return commonDir
  }
  return path.resolve(dir, commonDir)
}

/**
 * Check if ref1 is an ancestor of ref2 (i.e. fast-forward is possible).
 */
async function isAncestor(dir: string, ref1: string, ref2: string): Promise<boolean> {
  try {
    await execAsync(`git -C "${dir}" merge-base --is-ancestor "${ref1}" "${ref2}"`)
    return true
  } catch {
    return false
  }
}

/**
 * Check if a branch is already rebased onto target.
 * True if the merge-base equals the target ref (linear history).
 */
async function isRebasedOnto(dir: string, target: string): Promise<boolean> {
  try {
    const { stdout: mergeBase } = await execAsync(`git -C "${dir}" merge-base HEAD "${target}"`)
    const { stdout: targetSha } = await execAsync(`git -C "${dir}" rev-parse "${target}"`)
    return mergeBase.trim() === targetSha.trim()
  } catch {
    return false
  }
}

/**
 * Get files changed between two refs (for overlap detection with target worktree).
 */
async function getChangedFiles(dir: string, ref1: string, ref2: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`git -C "${dir}" diff --name-only "${ref1}" "${ref2}"`)
    return stdout.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Get dirty files in a directory using porcelain -z format.
 * Handles rename/copy entries which emit two NUL-separated paths:
 *   "XY new_path\0old_path\0" -- both paths are included in the result.
 */
async function getDirtyFiles(dir: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`git -C "${dir}" status --porcelain -z`)
    const files: string[] = []
    // Split on NUL. The format is: "XY path\0" for normal entries,
    // "XY new\0old\0" for renames/copies (status codes R or C).
    const parts = stdout.split('\0')
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
      // Rename/copy entries (R or C in either index or worktree column)
      // have an extra NUL-separated old path following
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
  } catch {
    return []
  }
}

/**
 * Check if the target worktree has dirty files that overlap with the push range.
 * Returns the list of overlapping files, or null if no overlap (safe to push).
 *
 * `receive.denyCurrentBranch=updateInstead` only rejects when pushed files
 * conflict with dirty files in the target. Non-overlapping dirty files are
 * left untouched by the push, so no stashing is needed.
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
 * Generate a squash commit message from branch name and full commit messages.
 * Includes the complete commit message (subject + body) for each commit,
 * preserving context from the worktree's development history.
 */
export function buildSquashMessage({ branchName, commitMessages }: {
  branchName: string
  commitMessages: string[]
}): string {
  const lines: string[] = [`worktree merge: ${branchName}`]
  if (commitMessages.length > 0) {
    lines.push('')
    for (const message of commitMessages) {
      // Each full commit message, prefixed with bullet
      const msgLines = message.split('\n')
      lines.push(`- ${msgLines[0]}`)
      // Indent continuation lines of multi-line commit messages
      for (const extra of msgLines.slice(1)) {
        lines.push(`  ${extra}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * Merge a worktree branch into the default branch using worktrunk-style pipeline.
 *
 * Pipeline:
 *   1. Commit any uncommitted changes (git add -A + git commit)
 *   2. Squash all commits since merge-base into one
 *   3. Rebase onto target if behind
 *   4. Fast-forward push via local git push (never touches main repo checkout)
 *   5. Switch to detached HEAD at target, delete branch
 *
 * The onProgress callback receives status messages for display in Discord or CLI.
 */
export async function mergeWorktree({ worktreeDir, mainRepoDir, worktreeName, onProgress }: {
  worktreeDir: string
  mainRepoDir: string
  worktreeName: string
  onProgress?: (message: string) => void
}): Promise<MergeWorktreeResult> {
  const log = (msg: string) => {
    logger.log(msg)
    onProgress?.(msg)
  }

  // Resolve current branch. If detached, create a temp branch.
  let branchName: string
  let tempBranch: string | null = null
  try {
    const { stdout } = await execAsync(`git -C "${worktreeDir}" symbolic-ref --short HEAD`)
    branchName = stdout.trim()
  } catch {
    // Detached HEAD -- create temp branch
    tempBranch = `kimaki-merge-${Date.now()}`
    await execAsync(`git -C "${worktreeDir}" checkout -b "${tempBranch}"`)
    branchName = tempBranch
  }
  if (!branchName) {
    branchName = worktreeName
  }

  const defaultBranch = await getDefaultBranch(mainRepoDir)
  log(`Merging ${branchName} into ${defaultBranch}`)

  // Helper to clean up temp branch on error
  const cleanupTempBranch = async () => {
    if (!tempBranch) {
      return
    }
    await execAsync(`git -C "${worktreeDir}" checkout --detach`).catch(() => {})
    await execAsync(`git -C "${worktreeDir}" branch -D "${tempBranch}"`).catch(() => {})
  }

  try {
    // ── Step 1: Reject uncommitted changes ──
    if (await isDirty(worktreeDir)) {
      await cleanupTempBranch()
      return {
        success: false,
        error: 'Uncommitted changes in worktree. Commit all changes before merging.',
      }
    }

    // ── Step 2: Squash all commits into one ──
    const { stdout: mergeBaseSha } = await execAsync(
      `git -C "${worktreeDir}" merge-base HEAD "${defaultBranch}"`,
    ).catch(() => {
      return { stdout: defaultBranch }
    })
    const mergeBase = mergeBaseSha.trim()

    const { stdout: commitCountStr } = await execAsync(
      `git -C "${worktreeDir}" rev-list --count "${mergeBase}..HEAD"`,
    )
    const commitCount = parseInt(commitCountStr.trim(), 10)

    if (commitCount === 0) {
      await cleanupTempBranch()
      return { success: false, error: 'No commits to merge -- branch is already up to date with target' }
    }

    // Always squash into a single commit with a proper message that
    // includes the full commit messages from the worktree's history.
    {
      const logRange = `${mergeBase}..HEAD`
      log(commitCount > 1 ? `Squashing ${commitCount} commits...` : 'Preparing merge commit...')

      // Use %B for full commit message (subject + body), separated by a
      // record separator so we can split without conflicting with newlines
      // inside commit messages.
      const SEP = '---KIMAKI-COMMIT-SEP---'
      const { stdout: messagesRaw } = await execAsync(
        `git -C "${worktreeDir}" log --format="%B${SEP}" --reverse "${logRange}"`,
      )
      const commitMessages = messagesRaw
        .split(SEP)
        .map((m) => {
          return m.trim()
        })
        .filter(Boolean)

      const squashMessage = buildSquashMessage({ branchName: worktreeName || branchName, commitMessages })

      await execAsync(`git -C "${worktreeDir}" reset --soft "${mergeBase}"`)
      await runGitWithStdin(['commit', '-m', squashMessage, '--'], worktreeDir, '')
    }

    // ── Step 3: Rebase onto target ──
    if (!await isRebasedOnto(worktreeDir, defaultBranch)) {
      log(`Rebasing onto ${defaultBranch}...`)
      try {
        await execAsync(`git -C "${worktreeDir}" rebase "${defaultBranch}"`, { timeout: 60_000 })
      } catch (e) {
        // Check if rebase left conflicts in progress.
        // Git uses rebase-merge (interactive/merge) or rebase-apply (am/patch).
        // git rev-parse --git-path returns a path relative to the worktree,
        // so resolve it against worktreeDir.
        const isRebasing = await (async () => {
          for (const dir of ['rebase-merge', 'rebase-apply']) {
            try {
              const { stdout } = await execAsync(
                `git -C "${worktreeDir}" rev-parse --git-path ${dir}`,
              )
              const resolvedPath = path.isAbsolute(stdout.trim())
                ? stdout.trim()
                : path.resolve(worktreeDir, stdout.trim())
              const exists = await fs.promises.access(resolvedPath).then(() => {
                return true
              }).catch(() => {
                return false
              })
              if (exists) {
                return true
              }
            } catch {
              // continue checking
            }
          }
          return false
        })()

        if (isRebasing) {
          return {
            success: false,
            error: `Rebase conflict while rebasing onto ${defaultBranch}. Resolve conflicts, then run merge again.`,
            conflictType: 'rebase',
          }
        }
        await cleanupTempBranch()
        return { success: false, error: `Rebase failed: ${e instanceof Error ? e.message : String(e)}` }
      }
    } else {
      log('Already rebased onto target')
    }

    // ── Step 4: Fast-forward push via local git push ──
    // This is the worktrunk approach: push to the git common dir with
    // receive.denyCurrentBranch=updateInstead. This fast-forwards the target
    // branch (and updates its working tree if a worktree exists) without
    // ever checking out the target in the main repo.

    // First verify fast-forward is possible
    if (!await isAncestor(worktreeDir, defaultBranch, 'HEAD')) {
      await cleanupTempBranch()
      return {
        success: false,
        error: `Cannot fast-forward: ${defaultBranch} has commits not in this branch. Someone may have pushed to ${defaultBranch} after rebase.`,
      }
    }

    // Check for conflicting dirty files in target worktree (main repo).
    // updateInstead only rejects overlapping files; non-overlapping dirty
    // files are left untouched, so no stashing is needed.
    const overlappingFiles = await checkTargetWorktreeConflicts({
      targetDir: mainRepoDir,
      sourceDir: worktreeDir,
      targetBranch: defaultBranch,
    })

    if (overlappingFiles) {
      await cleanupTempBranch()
      return {
        success: false,
        error: `Cannot merge: ${defaultBranch} worktree has uncommitted changes in files that would be overwritten:\n${overlappingFiles.join('\n')}\nCommit or stash these changes first.`,
      }
    }

    const gitCommonDir = await getGitCommonDir(worktreeDir)
    log(`Pushing to ${defaultBranch}...`)

    try {
      await execAsync(
        `git -C "${worktreeDir}" push --receive-pack="git -c receive.denyCurrentBranch=updateInstead receive-pack" "${gitCommonDir}" "HEAD:${defaultBranch}"`,
        { timeout: 30_000 },
      )
    } catch (e) {
      await cleanupTempBranch()
      return { success: false, error: `Push failed: ${e instanceof Error ? e.message : String(e)}` }
    }

    // Get short SHA for display
    const { stdout: shortSha } = await execAsync(`git -C "${worktreeDir}" rev-parse --short HEAD`)

    // ── Step 5: Clean up -- detach HEAD and delete branch ──
    log('Cleaning up worktree...')
    await execAsync(`git -C "${worktreeDir}" checkout --detach "${defaultBranch}"`)
    await execAsync(`git -C "${worktreeDir}" branch -D "${branchName}"`).catch(() => {})

    // Also delete the original worktree branch name if it differs from what we merged
    if (branchName !== worktreeName && worktreeName) {
      await execAsync(`git -C "${worktreeDir}" branch -D "${worktreeName}"`).catch(() => {})
    }

    return {
      success: true,
      defaultBranch,
      branchName: worktreeName || branchName,
      commitCount,
      shortSha: shortSha.trim(),
    }
  } catch (e) {
    await cleanupTempBranch()
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}
