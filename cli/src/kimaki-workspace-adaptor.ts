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
import {
  createWorktreeCore,
  KIMAKI_WORKTREE_ADAPTER_TYPE,
  removeWorktreeFromOwnRepository,
} from './git-worktree-core.js'

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

function getWorktreeIdentity(info: WorkspaceInfo) {
  if (!info.extra || typeof info.extra !== 'object') {
    return new Error('Kimaki worktree identity is missing')
  }
  const identity: { projectDirectory?: string; baseCommit?: string } = {}
  Object.assign(identity, info.extra)
  if (
    typeof identity.projectDirectory !== 'string' ||
    !path.isAbsolute(identity.projectDirectory)
  ) {
    return new Error('Kimaki worktree project directory must be absolute')
  }
  if (
    typeof identity.baseCommit !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(identity.baseCommit)
  ) {
    return new Error('Kimaki worktree base commit must be a full commit SHA')
  }
  return {
    projectDirectory: identity.projectDirectory,
    baseCommit: identity.baseCommit,
  }
}

function createKimakiWorktreeAdaptor(): WorkspaceAdapter {
  return {
    name: 'Kimaki Worktree',
    description: 'Create a git worktree managed by Kimaki',

    configure(info: WorkspaceInfo): WorkspaceInfo {
      const identity = getWorktreeIdentity(info)
      if (identity instanceof Error) throw identity
      const branchName = info.branch || info.name
      const directory = computeWorktreeDirectory({
        projectDirectory: identity.projectDirectory,
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
      const identity = getWorktreeIdentity(info)
      if (identity instanceof Error) throw identity
      const result = await createWorktreeCore({
        projectDirectory: identity.projectDirectory,
        targetDirectory: info.directory,
        branchName: info.branch || info.name,
        baseCommit: identity.baseCommit,
        // Silent log — plugin must not write to stdout/stderr
      })
      if (result instanceof Error) {
        throw result
      }
    },

    async remove(info: WorkspaceInfo): Promise<void> {
      if (!info.directory) return
      const result = await removeWorktreeFromOwnRepository({
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
  experimental_workspace,
}) => {
  experimental_workspace.register(
    KIMAKI_WORKTREE_ADAPTER_TYPE,
    createKimakiWorktreeAdaptor(),
  )
  return {}
}
