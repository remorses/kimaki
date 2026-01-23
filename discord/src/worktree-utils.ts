// Worktree utility functions.
// Wrapper for OpenCode worktree creation that also initializes git submodules.

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from './logger.js'
import type { getOpencodeClientV2 } from './opencode.js'

const execAsync = promisify(exec)

const logger = createLogger('WORKTREE-UTILS')

type OpencodeClientV2 = NonNullable<ReturnType<typeof getOpencodeClientV2>>

type WorktreeResult = {
  directory: string
  branch: string
}

/**
 * Create a worktree using OpenCode SDK and initialize git submodules.
 * This wrapper ensures submodules are properly set up in new worktrees.
 */
export async function createWorktreeWithSubmodules({
  clientV2,
  directory,
  name,
}: {
  clientV2: OpencodeClientV2
  directory: string
  name: string
}): Promise<WorktreeResult | Error> {
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

  // 2. Init submodules in new worktree (don't block on failure)
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

  // 3. Install dependencies using ni (detects package manager from lockfile)
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

  return response.data
}
