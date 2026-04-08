// OpenCode plugin that detects per-session system prompt drift across turns.
// When the effective system prompt changes after the first user message, it
// writes a debug diff file and shows a toast because prompt-cache invalidation
// increases rate-limit usage and usually means another plugin is mutating the
// system prompt unexpectedly.

import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from '@opencode-ai/plugin'
import { createPatch, diffLines } from 'diff'
import * as errore from 'errore'
import { createPluginLogger, formatPluginErrorWithStack, setPluginLogFilePath } from './plugin-logger.js'
import { initSentry, notifyError } from './sentry.js'
import { abbreviatePath } from './utils.js'

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
}

type SystemPromptDiff = {
  additions: number
  deletions: number
  patch: string
}

type TurnContext = {
  agent: string | undefined
  model: string | undefined
  directory: string
}

function getSystemPromptDiffDir({ dataDir }: { dataDir: string }): string {
  return path.join(dataDir, 'system-prompt-diffs')
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
  beforeLabel,
  afterLabel,
}: {
  beforeText: string
  afterText: string
  beforeLabel: string
  afterLabel: string
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
  const patch = createPatch(afterLabel, beforeText, afterText, beforeLabel, afterLabel)

  return {
    additions,
    deletions,
    patch,
  }
}

function writeSystemPromptDiffFile({
  dataDir,
  sessionId,
  beforePrompt,
  afterPrompt,
}: {
  dataDir: string
  sessionId: string
  beforePrompt: string
  afterPrompt: string
}): Error | {
  additions: number
  deletions: number
  filePath: string
  latestPromptPath: string
} {
  const diff = buildPatch({
    beforeText: beforePrompt,
    afterText: afterPrompt,
    beforeLabel: 'system-before.txt',
    afterLabel: 'system-after.txt',
  })
  const timestamp = new Date().toISOString().replaceAll(':', '-')
  const sessionDir = path.join(getSystemPromptDiffDir({ dataDir }), sessionId)
  const filePath = path.join(sessionDir, `${timestamp}.diff`)
  const latestPromptPath = path.join(sessionDir, `${timestamp}.md`)
  const fileContent = [
    `Session: ${sessionId}`,
    `Created: ${new Date().toISOString()}`,
    `Additions: ${diff.additions}`,
    `Deletions: ${diff.deletions}`,
    '',
    diff.patch,
  ].join('\n')

  return errore.try({
    try: () => {
      fs.mkdirSync(sessionDir, { recursive: true })
      fs.writeFileSync(filePath, fileContent)
      // fs.writeFileSync(latestPromptPath, afterPrompt)
        return {
          additions: diff.additions,
          deletions: diff.deletions,
          filePath,
          latestPromptPath,
        }
    },
    catch: (error) => {
      return new Error('Failed to write system prompt diff file', { cause: error })
    },
  })
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
  }
  sessions.set(sessionId, state)
  return state
}

async function handleSystemTransform({
  input,
  output,
  sessions,
  dataDir,
  client,
}: {
  input: SystemTransformInput
  output: SystemTransformOutput
  sessions: Map<string, SessionState>
  dataDir: string | undefined
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

  if (!dataDir) {
    return
  }

  const diffFileResult = writeSystemPromptDiffFile({
    dataDir,
    sessionId,
    beforePrompt: previousPrompt,
    afterPrompt: currentPrompt,
  })
  if (diffFileResult instanceof Error) {
    throw diffFileResult
  }

  await client.tui.showToast({
    body: {
      variant: 'info',
      title: 'Context cache discarded',
      message: appendToastSessionMarker({
        sessionId,
        message:
        `system prompt changed since the previous message (+${diffFileResult.additions} / -${diffFileResult.deletions}). ` +
        `Diff: \`${abbreviatePath(diffFileResult.filePath)}\`. ` +
        `Latest prompt: \`${abbreviatePath(diffFileResult.latestPromptPath)}\``,
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
          await handleSystemTransform({
            input,
            output,
            sessions,
            dataDir,
            client,
          })
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
