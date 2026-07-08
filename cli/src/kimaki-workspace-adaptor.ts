// Kimaki git worktree adaptor for OpenCode's experimental workspace system.
// Runs inside the opencode server process (NOT the bot process).
//
// PLUGIN SAFETY: This file must NOT import config.ts, logger.ts, or any
// module that pulls them in (like worktrees.ts). Uses git-worktree-core.ts
// which is designed to be plugin-safe (no logger/config dependencies).
// Never use console.log/console.error — plugins must be silent.

import type { Plugin, WorkspaceAdapter, WorkspaceInfo } from '@opencode-ai/plugin'
import crypto from 'node:crypto'
import path from 'node:path'
import { createWorktreeCore, removeWorktreeCore } from './git-worktree-core.js'

/**
 * Compute the on-disk directory for a managed worktree.
 * Mirrors getManagedWorktreeDirectory from worktrees.ts but reads KIMAKI_DATA_DIR
 * from the environment instead of config.ts (which is not available in the
 * opencode server process).
 */
function computeWorktreeDirectory({
  projectDirectory,
  branchName,
}: {
  projectDirectory: string
  branchName: string
}): string | Error {
  const dataDir = process.env.KIMAKI_DATA_DIR
  if (!dataDir) {
    return new Error('KIMAKI_DATA_DIR not set — cannot compute worktree directory')
  }
  const projectHash = crypto
    .createHash('sha1')
    .update(projectDirectory)
    .digest('hex')
    .slice(0, 8)
  const withoutPrefix = branchName
    .replace(/^opencode\/kimaki-/, '')
    .replaceAll('/', '-')
  return path.join(dataDir, 'worktrees', projectHash, withoutPrefix)
}

function createKimakiWorktreeAdaptor(projectDirectory: string): WorkspaceAdapter {
  return {
    name: 'Kimaki Worktree',
    description: 'Create a git worktree managed by Kimaki',

    configure(info: WorkspaceInfo): WorkspaceInfo {
      const branchName = info.branch || info.name
      const directory = computeWorktreeDirectory({
        projectDirectory,
        branchName,
      })
      if (directory instanceof Error) {
        return { ...info, branch: branchName }
      }
      return {
        ...info,
        name: info.name || branchName,
        branch: branchName,
        directory,
      }
    },

    async create(info: WorkspaceInfo): Promise<void> {
      if (!info.directory) {
        throw new Error('Workspace directory not set — configure() likely failed')
      }
      const baseBranch = (info.extra as { baseBranch?: string })?.baseBranch || undefined
      const result = await createWorktreeCore({
        projectDirectory,
        targetDirectory: info.directory,
        branchName: info.branch || info.name,
        baseBranch,
        // Silent log — plugin must not write to stdout/stderr
      })
      if (result instanceof Error) {
        throw result
      }
    },

    async remove(info: WorkspaceInfo): Promise<void> {
      if (!info.directory) return
      const result = await removeWorktreeCore({
        projectDirectory,
        worktreeDirectory: info.directory,
        branchName: info.branch || '',
      })
      if (result instanceof Error) {
        throw result
      }
    },

    target(info: WorkspaceInfo) {
      return {
        type: 'local' as const,
        directory: info.directory!,
      }
    },
  }
}

/**
 * Plugin entrypoint — registers the kimaki-worktree adaptor.
 * Called by OpenCode's plugin loader.
 */
export const kimakiWorkspaceAdaptorPlugin: Plugin = async ({
  directory,
  experimental_workspace,
}) => {
  experimental_workspace.register(
    'kimaki-worktree',
    createKimakiWorktreeAdaptor(directory),
  )
  return {}
}
