// OpenCode plugin that snapshots the MEMORY.md heading overview once per
// session and injects that frozen snapshot on the first real user message.
// The snapshot is cached by session ID so later MEMORY.md edits do not change
// the prompt for the same session and do not invalidate OpenCode's cache.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from '@opencode-ai/plugin'
import * as errore from 'errore'
import {
  createPluginLogger,
  formatPluginErrorWithStack,
  setPluginLogFilePath,
} from './plugin-logger.js'
import { condenseMemoryMd } from './condense-memory.js'
import { initSentry, notifyError } from './sentry.js'

const logger = createPluginLogger('OPENCODE')

type SessionState = {
  hasFrozenOverview: boolean
  frozenOverviewText: string | null
  injected: boolean
}

function createSessionState(): SessionState {
  return {
    hasFrozenOverview: false,
    frozenOverviewText: null,
    injected: false,
  }
}

function buildMemoryOverviewReminder({ condensed }: { condensed: string }): string {
  // Trailing newline so this synthetic part does not fuse with the next text
  // part when the model concatenates message parts.
  return `<system-reminder>Project memory from MEMORY.md (condensed table of contents, line numbers shown):\n${condensed}\nOnly headings are shown above — section bodies are hidden. Use Grep to search MEMORY.md for specific topics, or Read with offset and limit to read a section's content. When writing to MEMORY.md, keep titles concise (under 10 words) and content brief (2-3 sentences max). Only track non-obvious learnings that prevent future mistakes and are not already documented in code comments or AGENTS.md. Do not duplicate information that is self-evident from the code.</system-reminder>\n`
}

async function freezeMemoryOverview({
  directory,
  state,
}: {
  directory: string
  state: SessionState
}): Promise<string | null> {
  if (state.hasFrozenOverview) {
    return state.frozenOverviewText
  }

  const memoryPath = path.join(directory, 'MEMORY.md')
  const memoryContentResult = await fs.promises.readFile(memoryPath, 'utf-8').catch(() => {
    return null
  })
  if (!memoryContentResult) {
    state.hasFrozenOverview = true
    state.frozenOverviewText = null
    return null
  }

  const condensed = condenseMemoryMd(memoryContentResult)
  state.hasFrozenOverview = true
  state.frozenOverviewText = buildMemoryOverviewReminder({ condensed })
  return state.frozenOverviewText
}

const memoryOverviewPlugin: Plugin = async ({ directory }) => {
  initSentry()

  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setPluginLogFilePath(dataDir)
  }

  const sessions = new Map<string, SessionState>()

  function getOrCreateSessionState({ sessionID }: { sessionID: string }): SessionState {
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
      const result = await errore.tryAsync({
        try: async () => {
          const state = getOrCreateSessionState({ sessionID: input.sessionID })
          if (state.injected) {
            return
          }

          const firstPart = output.parts.find((part) => {
            if (part.type !== 'text') {
              return true
            }
            return part.synthetic !== true
          })
          if (!firstPart || firstPart.type !== 'text' || firstPart.text.trim().length === 0) {
            return
          }

          const overviewText = await freezeMemoryOverview({ directory, state })
          state.injected = true
          if (!overviewText) {
            return
          }

          output.parts.push({
            id: `prt_${crypto.randomUUID()}`,
            sessionID: input.sessionID,
            messageID: firstPart.messageID,
            type: 'text' as const,
            text: overviewText,
            synthetic: true,
          })
        },
        catch: (error) => {
          return new Error('memory overview chat.message hook failed', {
            cause: error,
          })
        },
      })
      if (!(result instanceof Error)) {
        return
      }
      logger.warn(
        `[memory-overview-plugin] ${formatPluginErrorWithStack(result)}`,
      )
      void notifyError(result, 'memory overview plugin chat.message hook failed')
    },
    event: async ({ event }) => {
      const result = await errore.tryAsync({
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
          return new Error('memory overview event hook failed', {
            cause: error,
          })
        },
      })
      if (!(result instanceof Error)) {
        return
      }
      logger.warn(`[memory-overview-plugin] ${formatPluginErrorWithStack(result)}`)
      void notifyError(result, 'memory overview plugin event hook failed')
    },
  }
}

export { memoryOverviewPlugin }
