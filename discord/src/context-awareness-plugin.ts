// OpenCode plugin that injects synthetic message parts for context awareness:
// - Git branch / detached HEAD changes
// - Working directory (pwd) changes (e.g. after /new-worktree mid-session)
// - MEMORY.md table of contents on first message
// - Idle time gap detection with timestamps
//
// Synthetic parts are hidden from the TUI but sent to the model, keeping it
// aware of context changes without cluttering the UI.
//
// When a worktree is created mid-session the bot clears the old opencode
// session and creates a new one under the worktree directory. The agent's
// conversation history in the new session won't have the old paths, but the
// user's follow-up message may reference the old plan. This plugin detects
// that the session's working directory differs from the project base directory
// and injects a notice so the agent uses the correct paths.
//
// Exported from opencode-plugin.ts — each export is treated as a separate
// plugin by OpenCode's plugin loader.

import type { Plugin } from '@opencode-ai/plugin'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as errore from 'errore'
import {
  createLogger,
  formatErrorWithStack,
  LogPrefix,
  setLogFilePath,
} from './logger.js'
import { setDataDir } from './config.js'
import { initSentry, notifyError } from './sentry.js'
import { execAsync } from './worktrees.js'
import { condenseMemoryMd } from './condense-memory.js'

const logger = createLogger(LogPrefix.OPENCODE)

type GitState = {
  key: string
  kind: 'branch' | 'detached-head' | 'detached-submodule'
  label: string
  warning: string | null
}

async function resolveGitState({
  directory,
}: {
  directory: string
}): Promise<GitState | null> {
  const branchResult = await errore.tryAsync(() => {
    return execAsync('git symbolic-ref --short HEAD', { cwd: directory })
  })
  if (!(branchResult instanceof Error)) {
    const branch = branchResult.stdout.trim()
    if (branch) {
      return {
        key: `branch:${branch}`,
        kind: 'branch',
        label: branch,
        warning: null,
      }
    }
  }

  const shaResult = await errore.tryAsync(() => {
    return execAsync('git rev-parse --short HEAD', { cwd: directory })
  })
  if (shaResult instanceof Error) {
    return null
  }

  const shortSha = shaResult.stdout.trim()
  if (!shortSha) {
    return null
  }

  const superprojectResult = await errore.tryAsync(() => {
    return execAsync('git rev-parse --show-superproject-working-tree', {
      cwd: directory,
    })
  })
  const superproject =
    superprojectResult instanceof Error ? '' : superprojectResult.stdout.trim()
  if (superproject) {
    return {
      key: `detached-submodule:${shortSha}`,
      kind: 'detached-submodule',
      label: `detached submodule @ ${shortSha}`,
      warning:
        `\n[warning: submodule is in detached HEAD at ${shortSha}. ` +
        'create or switch to a branch before committing.]',
    }
  }

  return {
    key: `detached-head:${shortSha}`,
    kind: 'detached-head',
    label: `detached HEAD @ ${shortSha}`,
    warning:
      `\n[warning: repository is in detached HEAD at ${shortSha}. ` +
      'create or switch to a branch before committing.]',
  }
}

// Resolve the session's actual working directory via the SDK.
// Cached per session to avoid repeated HTTP calls.
// The plugin client uses the v1 SDK style (path/query/body objects).
async function resolveSessionDirectory({
  client,
  sessionID,
  cache,
}: {
  client: PluginClient
  sessionID: string
  cache: Map<string, string>
}): Promise<string | null> {
  const cached = cache.get(sessionID)
  if (cached) {
    return cached
  }
  const result = await errore.tryAsync(() => {
    return client.session.get({ path: { id: sessionID } })
  })
  if (result instanceof Error || !result.data?.directory) {
    return null
  }
  cache.set(sessionID, result.data.directory)
  return result.data.directory
}

// Minimal type for the opencode plugin client (v1 SDK style with path objects).
// Only the methods we actually use are typed here.
type PluginClient = {
  session: {
    get: (params: { path: { id: string } }) => Promise<{ data?: { directory?: string } }>
  }
}

const contextAwarenessPlugin: Plugin = async ({ directory, client }) => {
  initSentry()

  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setDataDir(dataDir)
    setLogFilePath(dataDir)
  }

  // Per-session state for synthetic part injection
  const sessionGitStates = new Map<string, GitState>()
  const sessionLastMessageTime = new Map<string, number>()
  const sessionMemoryInjected = new Set<string>()
  // Cache for resolved session directories (avoids repeated session.get() calls).
  const sessionDirCache = new Map<string, string>()
  // Track which sessions have had the pwd notice injected. Separate from
  // the cache because resolveSessionDirectory populates the cache before
  // we compare, so using the same map for both would always see the value
  // as "already known" and skip injection.
  const sessionPwdAnnounced = new Map<string, string>()

  return {
    'chat.message': async (input, output) => {
      const hookResult = await errore.tryAsync({
        try: async () => {
          const now = Date.now()
          const first = output.parts.find((part) => {
            if (part.type !== 'text') {
              return true
            }
            return part.synthetic !== true
          })
          if (!first || first.type !== 'text' || first.text.trim().length === 0) {
            return
          }

          const { sessionID } = input
          const messageID = first.messageID

          // -- Resolve session working directory --
          // The session may have been created under a worktree path that
          // differs from the plugin-level `directory` (the project root).
          const sessionDir = await resolveSessionDirectory({
            client,
            sessionID,
            cache: sessionDirCache,
          })
          // Use session directory for git state resolution so branch detection
          // is accurate for worktree sessions (they have their own HEAD).
          const effectiveDirectory = sessionDir || directory

          // -- Branch / detached HEAD detection --
          // Resolved early but injected last so it appears at the end of parts.
          const gitState = await resolveGitState({ directory: effectiveDirectory })

          // -- Working directory change detection --
          // When the session's working directory differs from the project base
          // directory, inject a notice so the agent uses the correct file paths.
          // This covers the /new-worktree mid-session case: old session is
          // cleared, new session is created under the worktree path, and the
          // first user message needs to tell the agent about the new paths.
          if (sessionDir && sessionDir !== directory && sessionPwdAnnounced.get(sessionID) !== sessionDir) {
            // Session is in a worktree (or different directory than project root).
            // Inject once per distinct directory so the agent knows to use new paths.
            sessionPwdAnnounced.set(sessionID, sessionDir)
            output.parts.push({
              id: `prt_${crypto.randomUUID()}`,
              sessionID,
              messageID,
              type: 'text' as const,
              text:
                `\n[working directory is ${sessionDir} (git worktree of ${directory}). ` +
                `All file reads, writes, and edits must use paths under ${sessionDir}, ` +
                `not ${directory}.]`,
              synthetic: true,
            })
          }

          // -- MEMORY.md injection --
          // On the first user message in a session, read MEMORY.md from the
          // working directory and inject a condensed table of contents.
          if (!sessionMemoryInjected.has(sessionID)) {
            sessionMemoryInjected.add(sessionID)
            const memoryPath = path.join(effectiveDirectory, 'MEMORY.md')
            const memoryContent = await fs.promises
              .readFile(memoryPath, 'utf-8')
              .catch(() => null)
            if (memoryContent) {
              const condensed = condenseMemoryMd(memoryContent)
              output.parts.push({
                id: `prt_${crypto.randomUUID()}`,
                sessionID,
                messageID,
                type: 'text' as const,
                text: `<system-reminder>Project memory from MEMORY.md (condensed table of contents, line numbers shown):\n${condensed}\nOnly headings are shown above — section bodies are hidden. Use Grep to search MEMORY.md for specific topics, or Read with offset and limit to read a section's content. When writing to MEMORY.md, make headings detailed and descriptive since they are the only thing visible in this prompt. You can update MEMORY.md to store learnings, tips, insights that will help prevent same mistakes, and context worth preserving across sessions.</system-reminder>`,
                synthetic: true,
              })
            }
          }

          // -- Time since last message --
          // If more than 10 minutes passed since the last user message in this
          // session, inject current time context so the model is aware of the gap.
          const lastTime = sessionLastMessageTime.get(sessionID)
          sessionLastMessageTime.set(sessionID, now)

          if (lastTime) {
            const elapsed = now - lastTime
            const TEN_MINUTES = 10 * 60 * 1000
            if (elapsed >= TEN_MINUTES) {
              const totalMinutes = Math.floor(elapsed / 60_000)
              const hours = Math.floor(totalMinutes / 60)
              const minutes = totalMinutes % 60
              const elapsedStr =
                hours > 0 ? `${hours}h ${minutes}m` : `${totalMinutes}m`

              const utcStr = new Date(now)
                .toISOString()
                .replace('T', ' ')
                .replace(/\.\d+Z$/, ' UTC')
              const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone
              const localStr = new Date(now).toLocaleString('en-US', {
                timeZone: localTz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })

              output.parts.push({
                id: `prt_${crypto.randomUUID()}`,
                sessionID,
                messageID,
                type: 'text' as const,
                text: `[${elapsedStr} since last message | UTC: ${utcStr} | Local (${localTz}): ${localStr}]`,
                synthetic: true,
              })

              output.parts.push({
                id: `prt_${crypto.randomUUID()}`,
                sessionID,
                messageID,
                type: 'text' as const,
                text: '<system-reminder>Long gap since last message. If the previous conversation had important learnings, tips, insights that will help prevent same mistakes, or context worth preserving, update MEMORY.md before starting the new task.</system-reminder>',
                synthetic: true,
              })
            }
          }

          // -- Branch injection (last synthetic part) --
          // Placed last so branch context appears at the end of all injected parts.
          if (gitState) {
            const previousState = sessionGitStates.get(sessionID)
            if (!previousState || previousState.key !== gitState.key) {
              const info = (() => {
                if (gitState.warning) {
                  return gitState.warning
                }
                return `\n[current git branch is ${gitState.label}]`
              })()

              sessionGitStates.set(sessionID, gitState)
              output.parts.push({
                id: `prt_${crypto.randomUUID()}`,
                sessionID,
                messageID,
                type: 'text' as const,
                text: info,
                synthetic: true,
              })
            }
          }
        },
        catch: (error) => {
          return new Error('context-awareness chat.message hook failed', { cause: error })
        },
      })
      if (hookResult instanceof Error) {
        logger.warn(
          `[context-awareness-plugin] ${formatErrorWithStack(hookResult)}`,
        )
        void notifyError(hookResult, 'context-awareness plugin chat.message hook failed')
      }
    },

    // Clean up per-session tracking state when sessions are deleted
    event: async ({ event }) => {
      const cleanupResult = await errore.tryAsync({
        try: async () => {
          if (event.type !== 'session.deleted') {
            return
          }

          const id = event.properties?.info?.id
          if (!id) {
            return
          }

          sessionGitStates.delete(id)
          sessionLastMessageTime.delete(id)
          sessionMemoryInjected.delete(id)
          sessionDirCache.delete(id)
          sessionPwdAnnounced.delete(id)
        },
        catch: (error) => {
          return new Error('context-awareness event hook failed', { cause: error })
        },
      })
      if (cleanupResult instanceof Error) {
        logger.warn(
          `[context-awareness-plugin] ${formatErrorWithStack(cleanupResult)}`,
        )
        void notifyError(cleanupResult, 'context-awareness plugin event hook failed')
      }
    },
  }
}

export { contextAwarenessPlugin }
