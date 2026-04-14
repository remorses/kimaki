// OpenCode plugin that detects per-session system prompt drift across turns.
// When the effective system prompt changes after the first user message, it
// shows a short markdown diff snippet in a toast because prompt-cache
// invalidation increases rate-limit usage and usually means another plugin is
// mutating the system prompt unexpectedly.

import type { Plugin } from '@opencode-ai/plugin'
import { diffLines } from 'diff'
import * as errore from 'errore'
import { createPluginLogger, formatPluginErrorWithStack, setPluginLogFilePath } from './plugin-logger.js'
import { initSentry, notifyError } from './sentry.js'

const logger = createPluginLogger('OPENCODE')
const TOAST_SESSION_MARKER_SEPARATOR = ' '

type PluginHooks = Awaited<ReturnType<Plugin>>
type SystemTransformHook = NonNullable<PluginHooks['experimental.chat.system.transform']>
type SystemTransformInput = Parameters<SystemTransformHook>[0]
type SystemTransformOutput = Parameters<SystemTransformHook>[1]
type PluginEventHook = NonNullable<PluginHooks['event']>
type PluginEvent = Parameters<PluginEventHook>[0]['event']
type ChatMessageHook = NonNullable<PluginHooks['chat.message']>
type ChatMessageInput = Parameters<ChatMessageHook>[0]

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

type SystemPromptDiff = {
  additions: number
  deletions: number
  toastSnippet: string
}

type TurnContext = {
  agent: string | undefined
  model: string | undefined
  directory: string
}

function normalizeSystemPrompt({ system }: { system: string[] }): string {
  return system.join('\n')
}

function appendToastSessionMarker({
  message,
  sessionId,
}: {
  message: string
  sessionId: string
}): string {
  return `${message}${TOAST_SESSION_MARKER_SEPARATOR}${sessionId}`
}

function buildTurnContext({
  input,
  directory,
}: {
  input: ChatMessageInput
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

function shouldSuppressDiffNotice({
  previousContext,
  currentContext,
}: {
  previousContext: TurnContext | undefined
  currentContext: TurnContext | undefined
}): boolean {
  if (!previousContext || !currentContext) {
    return false
  }
  return (
    previousContext.agent !== currentContext.agent
    || previousContext.model !== currentContext.model
    || previousContext.directory !== currentContext.directory
  )
}

function buildPatch({
  beforeText,
  afterText,
}: {
  beforeText: string
  afterText: string
}): SystemPromptDiff {
  const changes = diffLines(beforeText, afterText)
  const additions = changes.reduce((count, change) => {
    if (!change.added) {
      return count
    }
    return count + change.count
  }, 0)
  const deletions = changes.reduce((count, change) => {
    if (!change.removed) {
      return count
    }
    return count + change.count
  }, 0)
  const diffLinesForToast: string[] = []
  const maxDiffLines = 100

  changes.forEach((change) => {
    if (diffLinesForToast.length >= maxDiffLines) {
      return
    }

    const prefix = change.added ? '+' : change.removed ? '-' : ' '
    const rawSegmentLines = change.value.split('\n')
    const normalizedSegmentLines = change.value.endsWith('\n')
      ? rawSegmentLines.slice(0, -1)
      : rawSegmentLines
    const segmentLines = normalizedSegmentLines.map((line) => {
      return `${prefix}${line}`
    })

    const remainingLines = maxDiffLines - diffLinesForToast.length
    diffLinesForToast.push(...segmentLines.slice(0, remainingLines))
  })

  const wasTruncated = diffLinesForToast.length === maxDiffLines
  const toastSnippetBody = wasTruncated
    ? [...diffLinesForToast.slice(0, -1), '… diff truncated …'].join('\n')
    : diffLinesForToast.join('\n')
  const toastSnippet = ['```diff', toastSnippetBody, '```'].join('\n')

  return {
    additions,
    deletions,
    toastSnippet,
  }
}

function getOrCreateSessionState({
  sessions,
  sessionId,
}: {
  sessions: Map<string, SessionState>
  sessionId: string
}): SessionState {
  const existing = sessions.get(sessionId)
  if (existing) {
    return existing
  }
  const state = {
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

async function handleSystemTransform({
  input,
  output,
  sessions,
  client,
}: {
  input: SystemTransformInput
  output: SystemTransformOutput
  sessions: Map<string, SessionState>
  client: Parameters<Plugin>[0]['client']
}): Promise<void> {
  const sessionId = input.sessionID
  if (!sessionId) {
    return
  }

  const currentPrompt = normalizeSystemPrompt({ system: output.system })
  const state = getOrCreateSessionState({
    sessions,
    sessionId,
  })
  const currentTurn = state.userTurnCount
  state.latestTurnPrompt = currentPrompt
  state.latestTurnPromptTurn = currentTurn

  if (currentTurn <= 1) {
    return
  }
  if (state.comparedTurn === currentTurn) {
    return
  }
  const previousPrompt = state.previousTurnPrompt
  state.comparedTurn = currentTurn
  if (!previousPrompt || previousPrompt === currentPrompt) {
    return
  }
  if (
    shouldSuppressDiffNotice({
      previousContext: state.previousTurnContext,
      currentContext: state.currentTurnContext,
    })
  ) {
    return
  }

  const promptDiff = buildPatch({
    beforeText: previousPrompt,
    afterText: currentPrompt,
  })

  await client.tui.showToast({
    body: {
      variant: 'info',
      title: 'Context cache discarded',
      message: appendToastSessionMarker({
        sessionId,
        message:
          `system prompt changed since the previous message (+${promptDiff.additions} / -${promptDiff.deletions}).\n${promptDiff.toastSnippet}`,
      }),
    },
  })
}

const systemPromptDriftPlugin: Plugin = async ({ client, directory }) => {
  initSentry()

  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setPluginLogFilePath(dataDir)
  }

  const sessions = new Map<string, SessionState>()

  return {
    'chat.message': async (input) => {
      const sessionId = input.sessionID
      if (!sessionId) {
        return
      }
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
      const result = await errore.tryAsync({
        try: async () => {
          const sessionId = input.sessionID
          if (!sessionId) {
            return
          }
          const state = getOrCreateSessionState({ sessions, sessionId })
          if (state.pendingCompareTimeout) {
            clearTimeout(state.pendingCompareTimeout)
          }
          // Delay one tick so other system-transform hooks can finish mutating
          // output.system before we snapshot it for drift detection.
          state.pendingCompareTimeout = setTimeout(() => {
            state.pendingCompareTimeout = undefined
            void errore.tryAsync({
              try: async () => {
                await handleSystemTransform({
                  input,
                  output,
                  sessions,
                  client,
                })
              },
              catch: (error) => {
                return new Error('system prompt drift transform hook failed', {
                  cause: error,
                })
              },
            }).then((delayedResult) => {
              if (!(delayedResult instanceof Error)) {
                return
              }
              logger.warn(
                `[system-prompt-drift-plugin] ${formatPluginErrorWithStack(delayedResult)}`,
              )
              void notifyError(
                delayedResult,
                'system prompt drift plugin transform hook failed',
              )
            })
          }, 0)
        },
        catch: (error) => {
          return new Error('system prompt drift transform hook failed', {
            cause: error,
          })
        },
      })
      if (result instanceof Error) {
        logger.warn(
          `[system-prompt-drift-plugin] ${formatPluginErrorWithStack(result)}`,
        )
        void notifyError(result, 'system prompt drift plugin transform hook failed')
      }
    },
    event: async ({ event }) => {
      const result = await errore.tryAsync({
        try: async () => {
          if (event.type !== 'session.deleted') {
            return
          }
          const deletedSessionId = getDeletedSessionId({ event })
          if (!deletedSessionId) {
            return
          }
          const state = sessions.get(deletedSessionId)
          if (state?.pendingCompareTimeout) {
            clearTimeout(state.pendingCompareTimeout)
          }
          sessions.delete(deletedSessionId)
        },
        catch: (error) => {
          return new Error('system prompt drift event hook failed', {
            cause: error,
          })
        },
      })
      if (result instanceof Error) {
        logger.warn(
          `[system-prompt-drift-plugin] ${formatPluginErrorWithStack(result)}`,
        )
        void notifyError(result, 'system prompt drift plugin event hook failed')
      }
    },
  }
}

function getDeletedSessionId({ event }: { event: PluginEvent }): string | undefined {
  if (event.type !== 'session.deleted') {
    return undefined
  }
  const sessionInfo = event.properties?.info
  if (!sessionInfo || typeof sessionInfo !== 'object') {
    return undefined
  }
  const id = 'id' in sessionInfo ? sessionInfo.id : undefined
  return typeof id === 'string' ? id : undefined
}

export { systemPromptDriftPlugin }
