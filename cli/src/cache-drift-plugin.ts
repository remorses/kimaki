// OpenCode plugin that detects system prompt drift across turns.
// When the system prompt changes between user messages, it logs a warning
// with addition/deletion line counts so you know context cache was discarded.
// This helps spot plugins that mutate the system prompt unexpectedly.

import type { Plugin } from '@opencode-ai/plugin'
import { diffLines } from 'diff'
import * as errore from 'errore'
import { createPluginLogger, formatPluginErrorWithStack, setPluginLogFilePath } from './plugin-logger.js'
import { initSentry, notifyError } from './sentry.js'

const logger = createPluginLogger('OPENCODE')

type SessionState = {
  userTurnCount: number
  previousTurnPrompt: string | undefined
  latestTurnPrompt: string | undefined
  latestTurnPromptTurn: number
  comparedTurn: number
  previousTurnContext: TurnContext | undefined
  currentTurnContext: TurnContext | undefined
  pendingCompareTimeout: ReturnType<typeof setTimeout> | undefined
}

type TurnContext = {
  agent: string | undefined
  model: string | undefined
  directory: string
}

function normalizeSystemPrompt({ system }: { system: string[] }): string {
  return system.join('\n')
}

function buildTurnContext({
  input,
  directory,
}: {
  input: { model?: { providerID: string; modelID: string }; variant?: string; agent?: string }
  directory: string
}): TurnContext {
  const model = input.model
    ? `${input.model.providerID}/${input.model.modelID}${input.variant ? `:${input.variant}` : ''}`
    : undefined
  return {
    agent: input.agent,
    model,
    directory,
  }
}

function shouldSuppressDriftWarning({
  previousContext,
  currentContext,
}: {
  previousContext: TurnContext | undefined
  currentContext: TurnContext | undefined
}): boolean {
  if (!previousContext || !currentContext) return false
  return (
    previousContext.agent !== currentContext.agent
    || previousContext.model !== currentContext.model
    || previousContext.directory !== currentContext.directory
  )
}

function countDiffLines({
  beforeText,
  afterText,
}: {
  beforeText: string
  afterText: string
}): { additions: number; deletions: number } {
  const changes = diffLines(beforeText, afterText)
  let additions = 0
  let deletions = 0
  for (const change of changes) {
    if (change.added) additions += change.count ?? 0
    if (change.removed) deletions += change.count ?? 0
  }
  return { additions, deletions }
}

function getOrCreateSessionState({
  sessions,
  sessionId,
}: {
  sessions: Map<string, SessionState>
  sessionId: string
}): SessionState {
  const existing = sessions.get(sessionId)
  if (existing) return existing
  const state: SessionState = {
    userTurnCount: 0,
    previousTurnPrompt: undefined,
    latestTurnPrompt: undefined,
    latestTurnPromptTurn: 0,
    comparedTurn: 0,
    previousTurnContext: undefined,
    currentTurnContext: undefined,
    pendingCompareTimeout: undefined,
  }
  sessions.set(sessionId, state)
  return state
}

function handleSystemTransform({
  input,
  output,
  sessions,
}: {
  input: { sessionID?: string }
  output: { system: string[] }
  sessions: Map<string, SessionState>
}): void {
  const sessionId = input.sessionID
  if (!sessionId) return

  const currentPrompt = normalizeSystemPrompt({ system: output.system })
  const state = getOrCreateSessionState({ sessions, sessionId })
  const currentTurn = state.userTurnCount
  state.latestTurnPrompt = currentPrompt
  state.latestTurnPromptTurn = currentTurn

  if (currentTurn <= 1) return
  if (state.comparedTurn === currentTurn) return

  const previousPrompt = state.previousTurnPrompt
  state.comparedTurn = currentTurn
  if (!previousPrompt || previousPrompt === currentPrompt) return

  if (
    shouldSuppressDriftWarning({
      previousContext: state.previousTurnContext,
      currentContext: state.currentTurnContext,
    })
  ) {
    return
  }

  const { additions, deletions } = countDiffLines({
    beforeText: previousPrompt,
    afterText: currentPrompt,
  })

  logger.warn(
    `[cache-drift] context cache discarded for session ${sessionId}: `
    + `system prompt changed since previous message (+${additions} / -${deletions} lines)`,
  )
}

function getDeletedSessionId({ event }: { event: { type: string; properties?: Record<string, unknown> } }): string | undefined {
  if (event.type !== 'session.deleted') return undefined
  const sessionInfo = event.properties?.info
  if (!sessionInfo || typeof sessionInfo !== 'object') return undefined
  const id = (sessionInfo as Record<string, unknown>).id
  return typeof id === 'string' ? id : undefined
}

const cacheDriftPlugin: Plugin = async ({ directory }) => {
  initSentry()

  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setPluginLogFilePath(dataDir)
  }

  const sessions = new Map<string, SessionState>()

  return {
    'chat.message': async (input) => {
      const sessionId = input.sessionID
      if (!sessionId) return
      const state = getOrCreateSessionState({ sessions, sessionId })
      if (
        state.userTurnCount > 0
        && state.latestTurnPromptTurn === state.userTurnCount
      ) {
        state.previousTurnPrompt = state.latestTurnPrompt
        state.previousTurnContext = state.currentTurnContext
      }
      state.currentTurnContext = buildTurnContext({ input, directory })
      state.userTurnCount += 1
    },
    'experimental.chat.system.transform': async (input, output) => {
      const result = errore.try({
        try: () => {
          const sessionId = input.sessionID
          if (!sessionId) return
          const state = getOrCreateSessionState({ sessions, sessionId })
          if (state.pendingCompareTimeout) {
            clearTimeout(state.pendingCompareTimeout)
          }
          // Delay one tick so other system-transform hooks can finish mutating
          // output.system before we snapshot it for drift detection.
          state.pendingCompareTimeout = setTimeout(() => {
            state.pendingCompareTimeout = undefined
            try {
              handleSystemTransform({ input, output, sessions })
            } catch (err) {
              logger.warn(`[cache-drift] ${formatPluginErrorWithStack(err)}`)
              void notifyError(err, 'cache drift plugin transform hook failed')
            }
          }, 0)
        },
        catch: (error) => {
          return new Error('cache drift transform hook failed', { cause: error })
        },
      })
      if (result instanceof Error) {
        logger.warn(`[cache-drift] ${formatPluginErrorWithStack(result)}`)
        void notifyError(result, 'cache drift plugin transform hook failed')
      }
    },
    event: async ({ event }) => {
      const result = errore.try({
        try: () => {
          if (event.type !== 'session.deleted') return
          const deletedSessionId = getDeletedSessionId({ event })
          if (!deletedSessionId) return
          const state = sessions.get(deletedSessionId)
          if (state?.pendingCompareTimeout) {
            clearTimeout(state.pendingCompareTimeout)
          }
          sessions.delete(deletedSessionId)
        },
        catch: (error) => {
          return new Error('cache drift event hook failed', { cause: error })
        },
      })
      if (result instanceof Error) {
        logger.warn(`[cache-drift] ${formatPluginErrorWithStack(result)}`)
        void notifyError(result, 'cache drift plugin event hook failed')
      }
    },
  }
}

export { cacheDriftPlugin }
