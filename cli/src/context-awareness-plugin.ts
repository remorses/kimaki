// OpenCode plugin that injects synthetic message parts for context awareness:
// - Git branch / detached HEAD changes
// - Working directory (pwd) changes (e.g. after /new-worktree mid-session)
// - Onboarding tutorial instructions (when TUTORIAL_WELCOME_TEXT detected)
// - Missing kimaki system prompt on session.command user messages
//
// Synthetic parts are hidden from the TUI but sent to the model, keeping it
// aware of context changes without cluttering the UI.
//
// State design: all per-session mutable state is encapsulated in a single
// SessionState object per session ID. One Map, one delete() on cleanup.
// Decision logic is extracted into pure functions that take state + input
// and return whether to inject — making them testable without mocking.
//
// v1 plugin. Not loaded by opencode2 until ported into kimaki-opencode-plugin/.

import type { Plugin } from '@opencode-ai/plugin'
import { FilesystemOperationError, OpenCodeSdkError } from './errors.js'
import crypto from 'node:crypto'
import {
  createPluginLogger,
  formatPluginErrorWithStack,
  setPluginLogFilePath,
} from './plugin-logger.js'
import { setDataDir } from './config.js'
import { createPluginClient } from './plugin-opencode-client.js'
import { initSentry, notifyError } from './sentry.js'
import { execAsync } from './exec-async.js'
import {
  ONBOARDING_TUTORIAL_INSTRUCTIONS,
  TUTORIAL_WELCOME_TEXT,
} from './onboarding-tutorial.js'

const logger = createPluginLogger('OPENCODE')

// ── Types ────────────────────────────────────────────────────────

type GitState = {
  key: string
  kind: 'branch' | 'detached-head' | 'detached-submodule'
  label: string
  warning: string | null
}

// All per-session mutable state in one place. One Map entry, one delete.
type SessionState = {
  gitState: GitState | undefined
  tutorialInjected: boolean
  // Last directory observed via session.get(). Refreshed on each real user
  // message so directory-change reminders compare the latest observed session
  // directory against the current request directory.
  resolvedDirectory: string | undefined
  // Last directory we announced via pwd injection.
  announcedDirectory: string | undefined
}

// Minimal type for the opencode v2 client (flat params).
type PluginClient = {
  session: {
    get: (params: { sessionID: string; directory?: string }) => Promise<{ data?: { directory?: string } }>
  }
}

// ── Pure derivation functions ────────────────────────────────────
// These take state + fresh input and return whether to inject.
// No side effects, no mutations — easy to test with fixtures.

export function shouldInjectBranch({
  previousGitState,
  currentGitState,
}: {
  previousGitState: GitState | undefined
  currentGitState: GitState | null
}): { inject: false } | { inject: true; text: string } {
  if (!currentGitState) {
    return { inject: false }
  }
  if (previousGitState && previousGitState.key === currentGitState.key) {
    return { inject: false }
  }
  // Trailing newline so this synthetic part does not fuse with the next text
  // part when the model concatenates message parts.
  const base = currentGitState.warning || `\n[current git branch is ${currentGitState.label}]`
  return { inject: true, text: `${base}\n` }
}

export function shouldInjectPwd({
  currentDir,
  previousDir,
  announcedDir,
}: {
  currentDir: string
  previousDir: string | undefined
  announcedDir: string | undefined
}): { inject: false } | { inject: true; text: string } {
  if (announcedDir === currentDir) {
    return { inject: false }
  }

  const priorDirectory = announcedDir || previousDir
  if (!priorDirectory || priorDirectory === currentDir) {
    return { inject: false }
  }

  return {
    inject: true,
    // Trailing newline so this synthetic part does not fuse with the next text
    // part when the model concatenates message parts.
    text:
      `\n[working directory changed (cwd / pwd has changed). ` +
      `The user expects you to edit files in the new cwd. ` +
      `Previous folder (DO NOT TOUCH): ${priorDirectory}. ` +
      `New folder (new cwd / pwd, edit files here): ${currentDir}. ` +
      `You MUST read, write, and edit files only under the new folder ${currentDir}. ` +
      `You MUST NOT read, write, or edit any files under the previous folder ${priorDirectory} — ` +
      `that folder is a separate checkout and the user or another agent may be actively working there, ` +
      `so writing to it would override their unrelated changes.]\n`,
  }
}

export function shouldInjectTutorial({
  alreadyInjected,
  parts,
}: {
  alreadyInjected: boolean
  parts: Array<{ type: string; text?: string }>
}): boolean {
  if (alreadyInjected) {
    return false
  }
  return parts.some((part) => {
    return part.type === 'text' && part.text?.includes(TUTORIAL_WELCOME_TEXT)
  })
}

// ── Impure helpers (I/O) ─────────────────────────────────────────

async function resolveGitState({
  directory,
}: {
  directory: string
}): Promise<GitState | null> {
  const branchResult = await execAsync('git symbolic-ref --short HEAD', { cwd: directory })
    .catch((e) => new FilesystemOperationError({ operation: 'gitBranch', cause: e }))
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

  const shaResult = await execAsync('git rev-parse --short HEAD', { cwd: directory })
    .catch((e) => new FilesystemOperationError({ operation: 'gitRevParse', cause: e }))
  if (shaResult instanceof Error) return null

  const shortSha = shaResult.stdout.trim()
  if (!shortSha) {
    return null
  }

  const superprojectResult = await execAsync('git rev-parse --show-superproject-working-tree', {
    cwd: directory,
  }).catch((e) => new FilesystemOperationError({ operation: 'gitSuperproject', cause: e }))
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

// Resolve the last observed session directory via the SDK.
// Refreshed on every real user message because sessions can switch directories
// mid-thread and the pwd reminder must compare old vs new accurately.
async function resolveSessionDirectory({
  client,
  sessionID,
  state,
}: {
  client: PluginClient
  sessionID: string
  state: SessionState
}): Promise<{
  currentDirectory: string | null
  previousDirectory: string | undefined
}> {
  const previousDirectory = state.resolvedDirectory
  const result = await client.session.get({ sessionID })
    .catch((e) => new OpenCodeSdkError({ operation: 'session.get', cause: e }))
  if (result instanceof Error || !result.data?.directory) {
    return {
      currentDirectory: previousDirectory || null,
      previousDirectory,
    }
  }
  state.resolvedDirectory = result.data.directory
  return {
    currentDirectory: result.data.directory,
    previousDirectory,
  }
}

// ── Plugin ───────────────────────────────────────────────────────

const contextAwarenessPlugin: Plugin = async ({ directory, serverUrl }) => {
  initSentry()

  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setDataDir(dataDir)
    setPluginLogFilePath(dataDir)
  }

  // Build our own v2 client. The plugin-provided ctx.client (v1) does not
  // reliably make REST calls from inside the plugin process.
  const fullClient = createPluginClient({ serverUrl, directory })
  logger.bindClient(fullClient)
  const client: PluginClient = fullClient

  // Single Map for all per-session state. One entry per session, one
  // delete on cleanup — no parallel Maps that can drift out of sync.
  const sessions = new Map<string, SessionState>()

  function getOrCreateSession(sessionID: string): SessionState {
    const existing = sessions.get(sessionID)
    if (existing) {
      return existing
    }
    const state: SessionState = {
      gitState: undefined,
      tutorialInjected: false,
      resolvedDirectory: undefined,
      announcedDirectory: undefined,
    }
    sessions.set(sessionID, state)
    return state
  }

  return {
    'chat.message': async (input, output) => {
      const hookResult = await (async () => {
          const { sessionID } = input
          const state = getOrCreateSession(sessionID)

          // -- Onboarding tutorial injection --
          // Runs before the non-synthetic text guard because the tutorial
          // marker (TUTORIAL_WELCOME_TEXT) can appear in synthetic/system
          // parts prepended by message-preprocessing.ts. The old separate
          // plugin had no such guard, so this preserves that behavior.
          const firstTextPart = output.parts.find((part) => {
            return part.type === 'text'
          })
          if (firstTextPart && shouldInjectTutorial({ alreadyInjected: state.tutorialInjected, parts: output.parts })) {
            state.tutorialInjected = true
            output.parts.push({
              id: `prt_${crypto.randomUUID()}`,
              sessionID,
              messageID: firstTextPart.messageID,
              type: 'text' as const,
              text: `<system-reminder>\n${ONBOARDING_TUTORIAL_INSTRUCTIONS}\n</system-reminder>\n`,
              synthetic: true,
            })
          }

          // -- Find first non-synthetic user text part --
          // All remaining injections (branch, pwd) only
          // apply to real user messages, not empty or synthetic-only messages.
          const first = output.parts.find((part) => {
            if (part.type !== 'text') {
              return true
            }
            return part.synthetic !== true
          })
          if (!first || first.type !== 'text' || first.text.trim().length === 0) {
            return
          }

          const messageID = first.messageID

          // -- Resolve session working directory --
          const sessionDirectory = await resolveSessionDirectory({
            client,
            sessionID,
            state,
          })
          // The plugin request directory is the current directory Kimaki asked
          // OpenCode to operate on for this message. Prefer it over session.get()
          // when they disagree so reminders and MEMORY/branch context follow the
          // new worktree immediately after a folder switch.
          const effectiveDirectory = directory

          // -- Branch / detached HEAD detection --
          // Resolved early but injected last so it appears at the end of parts.
          const gitState = await resolveGitState({ directory: effectiveDirectory })

          // -- Working directory change detection --
          const pwdResult = shouldInjectPwd({
            currentDir: effectiveDirectory,
            previousDir:
              sessionDirectory.previousDirectory ||
              (sessionDirectory.currentDirectory !== effectiveDirectory
                ? sessionDirectory.currentDirectory || undefined
                : undefined),
            announcedDir: state.announcedDirectory,
          })
          if (pwdResult.inject) {
            state.announcedDirectory = effectiveDirectory
            output.parts.push({
              id: `prt_${crypto.randomUUID()}`,
              sessionID,
              messageID,
              type: 'text' as const,
              text: pwdResult.text,
              synthetic: true,
            })
          }

          // -- Branch injection (last synthetic part) --
          const branchResult = shouldInjectBranch({
            previousGitState: state.gitState,
            currentGitState: gitState,
          })
          if (branchResult.inject) {
            state.gitState = gitState!
            output.parts.push({
              id: `prt_${crypto.randomUUID()}`,
              sessionID,
              messageID,
              type: 'text' as const,
              text: branchResult.text,
              synthetic: true,
            })
          }
      })().catch((error) => {
        return new Error('context-awareness chat.message hook failed', { cause: error })
      })
      if (hookResult instanceof Error) {
        logger.warn(
          `[context-awareness-plugin] ${formatPluginErrorWithStack(hookResult)}`,
        )
        void notifyError(hookResult, 'context-awareness plugin chat.message hook failed')
      }
    },

    // Clean up per-session state when sessions are deleted.
    // Single delete instead of parallel Map/Set deletes.
    event: async ({ event }) => {
      const cleanupResult = await (async () => {
          if (event.type !== 'session.deleted') {
            return
          }
          const id = event.properties?.info?.id
          if (!id) {
            return
          }
          sessions.delete(id)
      })().catch((error) => {
        return new Error('context-awareness event hook failed', { cause: error })
      })
      if (cleanupResult instanceof Error) {
        logger.warn(
          `[context-awareness-plugin] ${formatPluginErrorWithStack(cleanupResult)}`,
        )
        void notifyError(cleanupResult, 'context-awareness plugin event hook failed')
      }
    },
  }
}

export { contextAwarenessPlugin }
