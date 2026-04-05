// OpenCode plugin that injects synthetic message parts for context awareness:
// - Git branch / detached HEAD changes
// - Working directory (pwd) changes (e.g. after /new-worktree mid-session)
// - MEMORY.md table of contents on first message
// - MEMORY.md reminder after a large assistant reply
// - Onboarding tutorial instructions (when TUTORIAL_WELCOME_TEXT detected)
//
// Synthetic parts are hidden from the TUI but sent to the model, keeping it
// aware of context changes without cluttering the UI.
//
// State design: all per-session mutable state is encapsulated in a single
// SessionState object per session ID. One Map, one delete() on cleanup.
// Decision logic is extracted into pure functions that take state + input
// and return whether to inject — making them testable without mocking.
//
// Exported from kimaki-opencode-plugin.ts — each export is treated as a separate
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
import {
  ONBOARDING_TUTORIAL_INSTRUCTIONS,
  TUTORIAL_WELCOME_TEXT,
} from './onboarding-tutorial.js'

const logger = createLogger(LogPrefix.OPENCODE)

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
  memoryInjected: boolean
  lastMemoryReminderAssistantMessageId: string | undefined
  tutorialInjected: boolean
  // Last directory observed via session.get(). Refreshed on each real user
  // message so directory-change reminders compare the latest observed session
  // directory against the current request directory.
  resolvedDirectory: string | undefined
  // Last directory we announced via pwd injection.
  announcedDirectory: string | undefined
}

function createSessionState(): SessionState {
  return {
    gitState: undefined,
    memoryInjected: false,
    lastMemoryReminderAssistantMessageId: undefined,
    tutorialInjected: false,
    resolvedDirectory: undefined,
    announcedDirectory: undefined,
  }
}

// Minimal type for the opencode plugin client (v1 SDK style with path objects).
type PluginClient = {
  session: {
    get: (params: { path: { id: string } }) => Promise<{ data?: { directory?: string } }>
    messages: (params: {
      path: { id: string }
      query?: { directory?: string; limit?: number }
    }) => Promise<{ data?: Array<{ info: AssistantMessageInfo }> }>
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
  const text = currentGitState.warning || `\n[current git branch is ${currentGitState.label}]`
  return { inject: true, text }
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
    text:
      `\n[working directory changed. Previous working directory: ${priorDirectory}. ` +
      `Current working directory: ${currentDir}. ` +
      `You MUST read, write, and edit files only under ${currentDir}. ` +
      `Do NOT read, write, or edit files under ${priorDirectory}.]`,
  }
}

const MEMORY_REMINDER_OUTPUT_TOKENS = 12_000

type AssistantTokenUsage = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

type AssistantMessageInfo = {
  id: string
  role: string
  time?: { completed?: number; created?: number }
  tokens?: AssistantTokenUsage
}

function getOutputTokenTotal(tokens: AssistantTokenUsage): number {
  return Math.max(0, tokens.output + tokens.reasoning)
}

export function shouldInjectMemoryReminderFromLatestAssistant({
  lastMemoryReminderAssistantMessageId,
  latestAssistantMessage,
  threshold = MEMORY_REMINDER_OUTPUT_TOKENS,
}: {
  lastMemoryReminderAssistantMessageId?: string
  latestAssistantMessage: AssistantMessageInfo | undefined
  threshold?: number
}): { inject: false } | { inject: true; assistantMessageId: string } {
  if (!latestAssistantMessage) {
    return { inject: false }
  }
  if (latestAssistantMessage.role !== 'assistant') {
    return { inject: false }
  }
  if (typeof latestAssistantMessage.time?.completed !== 'number') {
    return { inject: false }
  }
  if (!latestAssistantMessage.tokens) {
    return { inject: false }
  }
  if (lastMemoryReminderAssistantMessageId === latestAssistantMessage.id) {
    return { inject: false }
  }
  const outputTokens = getOutputTokenTotal(latestAssistantMessage.tokens)
  if (outputTokens < threshold) {
    return { inject: false }
  }
  return { inject: true, assistantMessageId: latestAssistantMessage.id }
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
  const result = await errore.tryAsync(() => {
    return client.session.get({ path: { id: sessionID } })
  })
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

const contextAwarenessPlugin: Plugin = async ({ directory, client }) => {
  initSentry()

  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setDataDir(dataDir)
    setLogFilePath(dataDir)
  }

  // Single Map for all per-session state. One entry per session, one
  // delete on cleanup — no parallel Maps that can drift out of sync.
  const sessions = new Map<string, SessionState>()

  function getOrCreateSession(sessionID: string): SessionState {
    const existing = sessions.get(sessionID)
    if (existing) {
      return existing
    }
    const state = createSessionState()
    sessions.set(sessionID, state)
    return state
  }

  return {
    'chat.message': async (input, output) => {
      const hookResult = await errore.tryAsync({
        try: async () => {
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
              text: `<system-reminder>\n${ONBOARDING_TUTORIAL_INSTRUCTIONS}\n</system-reminder>`,
              synthetic: true,
            })
          }

          // -- Find first non-synthetic user text part --
          // All remaining injections (branch, pwd, memory, time gap) only
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

          const latestAssistantMessageResult = await errore.tryAsync(() => {
            return client.session.messages({
              path: { id: sessionID },
              query: { directory, limit: 20 },
            })
          })
          const latestAssistantMessage =
            latestAssistantMessageResult instanceof Error
              ? undefined
              : [...(latestAssistantMessageResult.data || [])]
                  .reverse()
                  .find((entry) => {
                    return entry.info.role === 'assistant'
                  })
                  ?.info

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

          // -- MEMORY.md injection --
          if (!state.memoryInjected) {
            state.memoryInjected = true
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

          const memoryReminder = shouldInjectMemoryReminderFromLatestAssistant({
            lastMemoryReminderAssistantMessageId:
              state.lastMemoryReminderAssistantMessageId,
            latestAssistantMessage,
          })
          if (memoryReminder.inject) {
            output.parts.push({
              id: `prt_${crypto.randomUUID()}`,
              sessionID,
              messageID,
              type: 'text' as const,
              text: '<system-reminder>The previous assistant message was large. If the previous conversation had important learnings, tips, insights that will help prevent the same mistakes, or context worth preserving, update MEMORY.md before starting the new task.</system-reminder>',
              synthetic: true,
            })
            state.lastMemoryReminderAssistantMessageId =
              memoryReminder.assistantMessageId
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

    // Clean up per-session state when sessions are deleted.
    // Single delete instead of parallel Map/Set deletes.
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
          sessions.delete(id)
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
