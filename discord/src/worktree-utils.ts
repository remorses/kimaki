// Worktree utility functions.
// Wrapper for OpenCode worktree creation that also initializes git submodules.
// Also handles capturing and applying git diffs when creating worktrees from threads.

import { exec, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { createLogger, LogPrefix } from './logger.js'
import type { getOpencodeClientV2 } from './opencode.js'

export const execAsync = promisify(exec)

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
