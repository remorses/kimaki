// Fixture-driven tests for pure event-stream derivation helpers.
// Focuses on assistant message completion boundaries instead of session.idle.

import fs from 'node:fs'
import path from 'node:path'
import type { Message as OpenCodeMessage } from '@opencode-ai/sdk/v2'
import { describe, expect, test } from 'vitest'
import { type OpencodeEventLogEntry } from './opencode-session-event-log.js'
import {
  derivePendingPermissionRequests,
  getAssistantMessageIdsForLatestUserTurn,
  getDerivedSubagentSessions,
  getEventBufferSessionId,
  getCurrentTurnStartTime,
  getDerivedSubtaskIndex,
  getLatestAssistantMessageIdForLatestUserTurn,
  getLatestRunInfo,
  getLatestTurnTokenUsage,
  getIdleTokenUsageDelta,
  getTokenUsageSessionIdsForIdle,
  isDerivedChildSession,
  hasAssistantMessageCompletedBefore,
  doesLatestUserTurnHaveNaturalCompletion,
  isAssistantMessageInLatestUserTurn,
  isAssistantMessageNaturalCompletion,
  isSummaryAssistantMessage,
  isSessionBusy,
  isAssistantTextReadyForQuestion,
  deriveLatestUnansweredQuestion,
  type EventBufferEntry,
} from './event-stream-state.js'

const fixturesDir = path.join(import.meta.dirname, 'event-stream-fixtures')
type AssistantMessage = Extract<OpenCodeMessage, { role: 'assistant' }>

function loadFixture(filename: string): EventBufferEntry[] {
  const content = fs.readFileSync(path.join(fixturesDir, filename), 'utf8')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as OpencodeEventLogEntry
      return { event: parsed.event, timestamp: parsed.timestamp }
    })
}

function getSessionId(events: EventBufferEntry[]): string {
  for (const entry of events) {
    const sessionId = getEventBufferSessionId(entry.event)
    if (sessionId) {
      return sessionId
    }
  }
  throw new Error('No sessionId found in fixture')
}

function getAssistantMessages(events: EventBufferEntry[], sessionId: string) {
  const messagesById = new Map<string, AssistantMessage>()
  events.forEach((entry) => {
    if (entry.event.type !== 'message.updated') {
      return
    }
    const info = entry.event.properties.info
    if (info.sessionID !== sessionId || info.role !== 'assistant') {
      return
    }
    messagesById.set(info.id, info)
  })
  return [...messagesById.values()]
}

function getAssistantMessageById({
  events,
  sessionId,
  messageId,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
}): AssistantMessage {
  const message = getAssistantMessages(events, sessionId).find((candidate) => {
    return candidate.id === messageId
  })
  if (!message) {
    throw new Error(`Assistant message ${messageId} not found`)
  }
  return message
}

// Test fixtures omit the top-level event `id` for brevity. The SDK event types
// require it, so inject a synthetic id when missing. Derivation never reads the
// top-level id (only properties.id / info.id), so the value is irrelevant.
let syntheticEventIdCounter = 0
function eventEntry(
  event: Omit<EventBufferEntry['event'], 'id'> & { id?: string },
): EventBufferEntry {
  const withId = ('id' in event && event.id
    ? event
    : { ...event, id: `evt_${++syntheticEventIdCounter}` }) as EventBufferEntry['event']
  return { event: withId, timestamp: 1 }
}

function findAssistantCompletionEventIndex({
  events,
  sessionId,
  messageId,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
}): number {
  const index = events.findIndex((entry) => {
    if (entry.event.type !== 'message.updated') {
      return false
    }
    const info = entry.event.properties.info
    return info.sessionID === sessionId
      && info.role === 'assistant'
      && info.id === messageId
      && typeof info.time.completed === 'number'
  })
  if (index === -1) {
    throw new Error(`Completed assistant message ${messageId} not found`)
  }
  return index
}

describe('session-normal-completion', () => {
  const events = loadFixture('session-normal-completion.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('latest assistant message completes naturally', () => {
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(true)
  })

  test('latest user turn start time comes from the latest user message', () => {
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(1772636294845)
  })

  test('completion history only appears after the completed update lands', () => {
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const completionIndex = findAssistantCompletionEventIndex({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(hasAssistantMessageCompletedBefore({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
      upToIndex: completionIndex - 1,
    })).toBe(false)
    expect(hasAssistantMessageCompletedBefore({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })).toBe(true)
  })

  test('completion history survives later non-completed duplicate updates', () => {
    const messageId = 'msg_duplicate_completion'
    const duplicateEvents: EventBufferEntry[] = [
      eventEntry({
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: messageId,
            sessionID: sessionId,
            role: 'assistant',
            time: { created: 1, completed: 2 },
            parentID: 'msg_user',
            modelID: 'deterministic-v2',
            providerID: 'deterministic-provider',
            mode: 'build',
            agent: 'build',
            path: { cwd: '/test', root: '/test' },
            cost: 0,
            tokens: {
              input: 1,
              output: 1,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish: 'stop',
          },
        },
      }),
      eventEntry({
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: messageId,
            sessionID: sessionId,
            role: 'assistant',
            time: { created: 1 },
            parentID: 'msg_user',
            modelID: 'deterministic-v2',
            providerID: 'deterministic-provider',
            mode: 'build',
            agent: 'build',
            path: { cwd: '/test', root: '/test' },
            cost: 0,
            finish: 'stop',
          },
        },
      }),
    ]

    expect(hasAssistantMessageCompletedBefore({
      events: duplicateEvents,
      sessionId,
      messageId,
    })).toBe(true)
  })

  test('getLatestRunInfo', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'deterministic-v2',
      providerID: 'deterministic-provider',
      agent: 'build',
      tokensUsed: 2,
    })
  })
})

describe('derivePendingPermissionRequests', () => {
  test('tracks unresolved permission requests', () => {
    const sessionId = 'ses_pending_permission'
    const events = [
      eventEntry({
        type: 'permission.asked',
        properties: {
          id: 'perm_1',
          sessionID: sessionId,
          permission: 'bash',
          patterns: ['*'],
          always: [],
          metadata: {},
        },
      }),
      eventEntry({
        type: 'permission.asked',
        properties: {
          id: 'perm_2',
          sessionID: sessionId,
          permission: 'edit',
          patterns: ['src/**'],
          always: [],
          metadata: {},
        },
      }),
      eventEntry({
        type: 'permission.replied',
        properties: {
          requestID: 'perm_1',
          sessionID: sessionId,
          reply: 'once',
        },
      }),
    ]

    expect(derivePendingPermissionRequests({ events, sessionId })).toMatchInlineSnapshot(`
      [
        "perm_2",
      ]
    `)
  })
})

describe('session-explicit-abort', () => {
  const events = loadFixture('session-explicit-abort.jsonl')
  const sessionId = getSessionId(events)
  const assistantMessages = getAssistantMessages(events, sessionId)
  const latestAssistant = assistantMessages[assistantMessages.length - 1]

  test('aborted assistant message is not a natural completion', () => {
    if (!latestAssistant) {
      throw new Error('Expected assistant message in fixture')
    }
    expect(isAssistantMessageNaturalCompletion({ message: latestAssistant })).toBe(false)
  })
})

describe('session-user-interruption', () => {
  const events = loadFixture('session-user-interruption.jsonl')
  const sessionId = getSessionId(events)
  const firstAssistantId = 'msg_cb95be135001I1vqtzLtT4Q1iQ'
  const slowSleepAssistantId = 'msg_cb95be39e001huREyY2wfjgV1M'
  const followupAssistantId = 'msg_cb95beeb8001MuEOER9WprXsPC'

  test('latest user turn only includes the follow-up assistant message', () => {
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: firstAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: slowSleepAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: followupAssistantId,
    })).toBe(true)
  })

  test('latest user turn start time follows the follow-up user message', () => {
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(1772636335777)
  })
})

describe('compaction summary during an active user turn', () => {
  const sessionId = 'ses_compaction'
  const userMessageId = 'msg_user_compaction'
  const replyMessageId = 'msg_reply_compaction'
  const summaryMessageId = 'msg_summary_compaction'

  function assistantEvent({
    messageId,
    created,
    completed,
    summary,
  }: {
    messageId: string
    created: number
    completed?: number
    summary?: true
  }): EventBufferEntry {
    return eventEntry({
      type: 'message.updated',
      properties: {
        sessionID: sessionId,
        info: {
          id: messageId,
          sessionID: sessionId,
          role: 'assistant',
          parentID: userMessageId,
          time: { created, completed },
          modelID: summary ? 'compaction-model' : 'reply-model',
          providerID: 'test-provider',
          mode: summary ? 'compaction' : 'build',
          agent: summary ? 'compaction' : 'build',
          path: { cwd: '/test', root: '/test' },
          cost: summary ? 2 : 1,
          tokens: {
            input: summary ? 20 : 10,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: completed ? 'stop' : undefined,
          summary,
        },
      },
    })
  }

  const activeEvents = [
    eventEntry({
      type: 'message.updated',
      properties: {
        sessionID: sessionId,
        info: {
          id: userMessageId,
          sessionID: sessionId,
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'test-provider', modelID: 'reply-model' },
        },
      },
    }),
    assistantEvent({ messageId: replyMessageId, created: 2 }),
    assistantEvent({
      messageId: summaryMessageId,
      created: 3,
      completed: 4,
      summary: true,
    }),
  ]

  test('compaction completion does not replace or complete the user-facing reply', () => {
    expect(getAssistantMessageIdsForLatestUserTurn({
      events: activeEvents,
      sessionId,
    })).toEqual(new Set([replyMessageId]))
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events: activeEvents,
      sessionId,
    })).toBe(replyMessageId)
    expect(isAssistantMessageInLatestUserTurn({
      events: activeEvents,
      sessionId,
      messageId: summaryMessageId,
    })).toBe(false)
    expect(doesLatestUserTurnHaveNaturalCompletion({
      events: activeEvents,
      sessionId,
    })).toBe(false)
  })

  test('summary identity is derivable while its billed usage remains counted', () => {
    expect(isSummaryAssistantMessage({
      events: activeEvents,
      sessionId,
      messageId: summaryMessageId,
    })).toBe(true)
    expect(isAssistantMessageNaturalCompletion({
      message: getAssistantMessageById({
        events: activeEvents,
        sessionId,
        messageId: summaryMessageId,
      }),
    })).toBe(false)
    expect(getLatestRunInfo({ events: activeEvents, sessionId })).toEqual({
      model: 'reply-model',
      providerID: 'test-provider',
      agent: 'build',
      tokensUsed: 11,
    })
    expect(getLatestTurnTokenUsage({ events: activeEvents, sessionId })).toMatchObject({
      total: 32,
      cost: 3,
      assistantMessageCount: 2,
    })
  })

  test('the real continuation still completes normally after compaction', () => {
    const completedEvents = [
      ...activeEvents,
      assistantEvent({ messageId: replyMessageId, created: 2, completed: 5 }),
    ]
    expect(doesLatestUserTurnHaveNaturalCompletion({
      events: completedEvents,
      sessionId,
    })).toBe(true)
  })
})

describe('session-two-completions-same-session', () => {
  const events = loadFixture('session-two-completions-same-session.jsonl')
  const sessionId = getSessionId(events)
  const assistantMessages = getAssistantMessages(events, sessionId)
  const firstAssistant = assistantMessages[0]
  const secondAssistant = assistantMessages[1]

  test('latest user turn points at the second completion only', () => {
    if (!firstAssistant || !secondAssistant) {
      throw new Error('Expected two assistant messages in fixture')
    }
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: firstAssistant.id,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: secondAssistant.id,
    })).toBe(true)
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })).toBe(secondAssistant.id)
  })
})

describe('session-concurrent-messages-serialized', () => {
  const events = loadFixture('session-concurrent-messages-serialized.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('fixture latest turn is still incomplete even though an older turn completed', () => {
    expect(doesLatestUserTurnHaveNaturalCompletion({
      events,
      sessionId,
    })).toBe(false)
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(message.id).toBe(latestAssistantMessageId)
  })
})

describe('session-tool-call-noisy-stream', () => {
  const events = loadFixture('session-tool-call-noisy-stream.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('fixture ends busy on a tool-call handoff message', () => {
    expect(isSessionBusy({ events, sessionId })).toBe(true)
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(false)
  })

  test('getLatestRunInfo still works through dense tool events', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'deterministic-v2',
      providerID: 'deterministic-provider',
      agent: 'build',
      tokensUsed: 0,
    })
  })
})

describe('session-voice-queued-followup', () => {
  const events = loadFixture('session-voice-queued-followup.jsonl')
  const sessionId = getSessionId(events)

  test('latest user turn start moves to the queued follow-up', () => {
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(1772636414577)
  })
})

describe('synthetic-question-followup', () => {
  const sessionId = 'ses_question'
  const events: EventBufferEntry[] = [
    {
      timestamp: 1,
      event: {
        id: 'evt_user_1',
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: 'msg_user_1',
            sessionID: sessionId,
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: {
              providerID: 'deterministic-provider',
              modelID: 'deterministic-v2',
            },
          },
        },
      },
    },
    {
      timestamp: 2,
      event: {
        id: 'evt_asst_1',
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: 'msg_asst_1',
            sessionID: sessionId,
            role: 'assistant',
            time: { created: 2, completed: 3 },
            parentID: 'msg_user_1',
            modelID: 'deterministic-v2',
            providerID: 'deterministic-provider',
            mode: 'build',
            agent: 'build',
            path: { cwd: '/test', root: '/test' },
            cost: 0,
            tokens: {
              input: 1,
              output: 1,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish: 'stop',
          },
        },
      },
    },
    {
      timestamp: 4,
      event: {
        id: 'evt_user_2',
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: 'msg_user_2',
            sessionID: sessionId,
            role: 'user',
            time: { created: 4 },
            agent: 'build',
            model: {
              providerID: 'deterministic-provider',
              modelID: 'deterministic-v2',
            },
          },
        },
      },
    },
  ]

  test('latest user turn flips immediately after the follow-up user message', () => {
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: 'msg_asst_1',
    })).toBe(false)
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(4)
  })
})

describe('real-session-task-normal', () => {
  const events = loadFixture('real-session-task-normal.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('latest assistant completion is terminal', () => {
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(true)
  })

  test('getLatestRunInfo has model info', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'gemini-2.5-flash',
      providerID: 'cached-google-real-events',
      agent: 'build',
      tokensUsed: 39025,
    })
  })
})

describe('real-session-task-user-interruption', () => {
  const events = loadFixture('real-session-task-user-interruption.jsonl')
  const sessionId = getSessionId(events)
  const childSessionId = 'ses_3464f3a1dffeBBD0d15EqnGjAh'
  const firstAssistantId = 'msg_cb9b0ba96001SpPjgzxWPmRuW9'
  const secondAssistantId = 'msg_cb9b1ae5c001E5G3Ql6aXNpst2'

  test('tool-call handoff assistant is not a natural completion but the resumed reply is', () => {
    const firstAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: firstAssistantId,
    })
    const secondAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: secondAssistantId,
    })
    // The first message finished with tool-calls — not a natural completion
    // (footer is deferred to session.idle). The second message IS natural.
    expect(isAssistantMessageNaturalCompletion({ message: firstAssistant })).toBe(false)
    expect(isAssistantMessageNaturalCompletion({ message: secondAssistant })).toBe(true)
  })

  test('latest user turn keeps both assistant messages for the same user turn', () => {
    const assistantIds = getAssistantMessageIdsForLatestUserTurn({ events, sessionId })
    expect(assistantIds.has(firstAssistantId)).toBe(true)
    expect(assistantIds.has(secondAssistantId)).toBe(true)
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })).toBe(secondAssistantId)
  })

  test('getDerivedSubtaskIndex starts at 1 for first task of assistant message', () => {
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId: sessionId,
      candidateSessionId: childSessionId,
    })).toBe(1)
  })

  test('getDerivedSubtaskIndex restarts at 1 for a newer assistant message', () => {
    const firstTaskEvent = events.find((entry) => {
      if (entry.event.type !== 'message.part.updated') {
        return false
      }
      const part = entry.event.properties.part
      if (part.sessionID !== sessionId) {
        return false
      }
      if (part.type !== 'tool' || part.tool !== 'task') {
        return false
      }
      if (part.state.status !== 'running' && part.state.status !== 'completed') {
        return false
      }
      return part.state.metadata?.sessionId === childSessionId
    })
    if (!firstTaskEvent) {
      throw new Error('Expected to find task tool event in fixture')
    }

    const secondChildSessionId = 'ses_synthetic_child_2'
    const thirdChildSessionId = 'ses_synthetic_child_3'
    const syntheticAssistantMessageId = 'msg_synthetic_new_assistant'

    const secondTaskEvent = structuredClone(firstTaskEvent)
    if (secondTaskEvent.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated event')
    }
    const secondTaskPart = secondTaskEvent.event.properties.part
    if (secondTaskPart.type !== 'tool' || secondTaskPart.tool !== 'task') {
      throw new Error('Expected task tool part')
    }
    if (secondTaskPart.state.status !== 'completed') {
      throw new Error('Expected completed task tool part')
    }
    secondTaskPart.id = `${secondTaskPart.id}-synthetic-2`
    secondTaskPart.messageID = syntheticAssistantMessageId
    secondTaskPart.state = {
      ...secondTaskPart.state,
      metadata: {
        ...(secondTaskPart.state.metadata || {}),
        sessionId: secondChildSessionId,
      },
      output: `task_id: ${secondChildSessionId}`,
    }

    const thirdTaskEvent = structuredClone(secondTaskEvent)
    if (thirdTaskEvent.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated event')
    }
    const thirdTaskPart = thirdTaskEvent.event.properties.part
    if (thirdTaskPart.type !== 'tool' || thirdTaskPart.tool !== 'task') {
      throw new Error('Expected task tool part')
    }
    if (thirdTaskPart.state.status !== 'completed') {
      throw new Error('Expected completed task tool part')
    }
    thirdTaskPart.id = `${thirdTaskPart.id}-synthetic-3`
    thirdTaskPart.messageID = syntheticAssistantMessageId
    thirdTaskPart.state = {
      ...thirdTaskPart.state,
      metadata: {
        ...(thirdTaskPart.state.metadata || {}),
        sessionId: thirdChildSessionId,
      },
      output: `task_id: ${thirdChildSessionId}`,
    }

    const lastTimestamp = events[events.length - 1]?.timestamp || 0
    const augmentedEvents: EventBufferEntry[] = [
      ...events,
      {
        timestamp: lastTimestamp + 1,
        event: secondTaskEvent.event,
      },
      {
        timestamp: lastTimestamp + 2,
        event: thirdTaskEvent.event,
      },
    ]

    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: childSessionId,
    })).toBe(1)
    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: secondChildSessionId,
    })).toBe(1)
    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: thirdChildSessionId,
    })).toBe(2)
  })

  test('getDerivedSubtaskIndex returns undefined for unknown session', () => {
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId: sessionId,
      candidateSessionId: 'ses_nonexistent',
    })).toBe(undefined)
  })

  test('getDerivedSubagentSessions returns latest tasks first with agent labels', () => {
    const firstTaskEvent = events.find((entry) => {
      if (entry.event.type !== 'message.part.updated') {
        return false
      }
      const part = entry.event.properties.part
      if (part.sessionID !== sessionId) {
        return false
      }
      if (part.type !== 'tool' || part.tool !== 'task') {
        return false
      }
      return part.state.status === 'running' || part.state.status === 'completed'
    })
    if (!firstTaskEvent || firstTaskEvent.event.type !== 'message.part.updated') {
      throw new Error('Expected to find task tool event in fixture')
    }

    const newerTaskEvent = structuredClone(firstTaskEvent)
    if (newerTaskEvent.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated event')
    }
    const newerTaskPart = newerTaskEvent.event.properties.part
    if (newerTaskPart.type !== 'tool' || newerTaskPart.tool !== 'task') {
      throw new Error('Expected task tool part')
    }
    if (newerTaskPart.state.status !== 'running' && newerTaskPart.state.status !== 'completed') {
      throw new Error('Expected running or completed task tool part')
    }
    newerTaskPart.id = `${newerTaskPart.id}-newer`
    newerTaskPart.state = {
      ...newerTaskPart.state,
      input: {
        ...newerTaskPart.state.input,
        description: 'inspect recent task output',
        subagent_type: 'explore',
      },
      metadata: {
        ...(newerTaskPart.state.metadata || {}),
        sessionId: 'ses_newer_child',
      },
    }

    const latestTimestamp = events[events.length - 1]?.timestamp || 0
    const augmentedEvents: EventBufferEntry[] = [
      ...events,
      {
        timestamp: latestTimestamp + 1,
        event: newerTaskEvent.event,
      },
    ]

    expect(getDerivedSubagentSessions({
      events: augmentedEvents,
      mainSessionId: sessionId,
    })).toMatchInlineSnapshot(`
      [
        {
          "childSessionId": "ses_newer_child",
          "description": "inspect recent task output",
          "subagentType": "explore",
          "timestamp": 1772641957983,
        },
        {
          "childSessionId": "ses_3464f3a1dffeBBD0d15EqnGjAh",
          "description": undefined,
          "subagentType": undefined,
          "timestamp": 1772641955371,
        },
      ]
    `)
  })
})

describe('real-session-action-buttons', () => {
  const events = loadFixture('real-session-action-buttons.jsonl')
  const sessionId = getSessionId(events)
  const toolCallAssistantId = 'msg_cb9b55c3b001hXC9qxjVxLMypM'
  const finalAssistantId = 'msg_cb9b5ddd1001FALqKNM6xW98u6'

  test('tool-call handoff assistant is not a natural completion but final reply is', () => {
    const toolCallAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: toolCallAssistantId,
    })
    const finalAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: finalAssistantId,
    })
    // The tool-call message has finish="tool-calls" — not a natural completion
    // (footer is deferred to session.idle). The final text message IS natural.
    expect(isAssistantMessageNaturalCompletion({ message: toolCallAssistant })).toBe(false)
    expect(isAssistantMessageNaturalCompletion({ message: finalAssistant })).toBe(true)
  })

  test('latest user turn keeps both assistant messages for the same user turn', () => {
    const assistantIds = getAssistantMessageIdsForLatestUserTurn({ events, sessionId })
    expect(assistantIds.has(toolCallAssistantId)).toBe(true)
    expect(assistantIds.has(finalAssistantId)).toBe(true)
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })).toBe(finalAssistantId)
  })
})

describe('real-session-permission-external-file', () => {
  const events = loadFixture('real-session-permission-external-file.jsonl')
  const sessionId = getSessionId(events)

  test('permission flow has no terminal assistant completion yet', () => {
    const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })
    expect(latestAssistantMessageId).toBeDefined()
    if (!latestAssistantMessageId) {
      return
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(false)
  })
})

describe('real-session-footer-suppressed-on-pre-idle-interrupt', () => {
  const events = loadFixture('real-session-footer-suppressed-on-pre-idle-interrupt.jsonl')
  const sessionId = getSessionId(events)
  const oldAssistantId = 'msg_cbda8f408001VATHNUi9l05XqA'
  const abortedAssistantId = 'msg_cbda90cef001GOQW8EQxkUz9b5'
  const latestAssistantId = 'msg_cbda91463001DvEB6YMCXayZNj'

  test('latest user turn ignores stale assistant messages from the interrupted turn', () => {
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: oldAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: abortedAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: latestAssistantId,
    })).toBe(true)
  })
})

describe('getLatestTurnTokenUsage', () => {
  function userEvent({
    sessionId,
    messageId,
    created,
  }: {
    sessionId: string
    messageId: string
    created: number
  }) {
    return eventEntry({
      type: 'message.updated',
      properties: {
        sessionID: sessionId,
        info: {
          id: messageId,
          sessionID: sessionId,
          role: 'user',
          time: { created },
          agent: 'build',
          model: {
            providerID: 'openai',
            modelID: 'gpt-5.3-codex',
          },
        },
      },
    })
  }

  function assistantEvent({
    sessionId,
    messageId,
    parentID,
    created,
    tokens,
    cost = 0,
    modelID = 'gpt-5.3-codex',
    providerID = 'openai',
  }: {
    sessionId: string
    messageId: string
    parentID: string
    created: number
    tokens: {
      total?: number
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    cost?: number
    modelID?: string
    providerID?: string
  }) {
    return eventEntry({
      type: 'message.updated',
      properties: {
        sessionID: sessionId,
        info: {
          id: messageId,
          sessionID: sessionId,
          role: 'assistant',
          time: { created, completed: created + 1 },
          parentID,
          modelID,
          providerID,
          mode: 'build',
          agent: 'build',
          path: { cwd: '/test', root: '/test' },
          cost,
          tokens,
          finish: 'stop',
        },
      },
    })
  }

  test('sums latest snapshot per assistant message in the latest turn', () => {
    const sessionId = 'ses_tokens'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 100,
          output: 20,
          reasoning: 5,
          cache: { read: 10, write: 2 },
        },
        cost: 1,
      }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_1',
        created: 3,
        tokens: {
          input: 50,
          output: 8,
          reasoning: 1,
          cache: { read: 4, write: 0 },
        },
        cost: 2,
      }),
    ]

    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 150,
      output: 28,
      reasoning: 6,
      cacheRead: 14,
      cacheWrite: 2,
      total: 200,
      cost: 3,
      model: 'gpt-5.3-codex',
      providerID: 'openai',
      assistantMessageCount: 2,
      userMessageId: 'msg_user_1',
    })
  })

  test('ignores previous-turn assistant messages', () => {
    const sessionId = 'ses_tokens_turns'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          input: 1000,
          output: 100,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
      userEvent({ sessionId, messageId: 'msg_user_2', created: 3 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_2',
        parentID: 'msg_user_2',
        created: 4,
        tokens: {
          input: 7,
          output: 3,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: 'gemini-2.5-flash',
        providerID: 'google',
      }),
    ]

    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 7,
      output: 3,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 10,
      cost: 0,
      model: 'gemini-2.5-flash',
      providerID: 'google',
      assistantMessageCount: 1,
      userMessageId: 'msg_user_2',
    })
  })

  test('returns zeros when the latest turn has no assistant tokens', () => {
    const sessionId = 'ses_empty'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
    ]

    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cost: 0,
      model: undefined,
      providerID: undefined,
      assistantMessageCount: 0,
      userMessageId: 'msg_user_1',
    })
  })

  test('real-session-task-normal uses the completed assistant snapshot', () => {
    const events = loadFixture('real-session-task-normal.jsonl')
    const sessionId = getSessionId(events)
    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 39025,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 39025,
      cost: 0,
      model: 'gemini-2.5-flash',
      providerID: 'cached-google-real-events',
      assistantMessageCount: 1,
      userMessageId: 'msg_cb9aae4c9001CxCOkoqgiXRsi1',
    })
  })

  test('real-session-task-user-interruption sums both assistant steps', () => {
    const events = loadFixture('real-session-task-user-interruption.jsonl')
    const sessionId = getSessionId(events)
    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 82526,
      output: 79,
      reasoning: 115,
      cacheRead: 0,
      cacheWrite: 0,
      total: 82720,
      cost: 0,
      model: 'gemini-2.5-flash',
      providerID: 'cached-google-real-events',
      assistantMessageCount: 2,
      userMessageId: 'msg_cb9b0ba6c001i3YH7bGffdB6BF',
    })
  })

  test('uses tokens.total when it differs from the component sum', () => {
    const sessionId = 'ses_canonical_total'
    const events = [
      userEvent({ sessionId, messageId: 'msg_user_1', created: 1 }),
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_user_1',
        created: 2,
        tokens: {
          total: 47319,
          input: 1217,
          output: 278,
          reasoning: 54,
          cache: { read: 45824, write: 0 },
        },
      }),
    ]

    expect(getLatestTurnTokenUsage({ events, sessionId })).toMatchObject({
      input: 1217,
      output: 278,
      reasoning: 54,
      cacheRead: 45824,
      cacheWrite: 0,
      total: 47319,
      assistantMessageCount: 1,
    })
  })

  test('real-session-task-three-parallel-sleeps uses billed totals', () => {
    const events = loadFixture('real-session-task-three-parallel-sleeps.jsonl')
    const sessionId = getSessionId(events)
    expect(getLatestTurnTokenUsage({ events, sessionId })).toMatchObject({
      input: 47139,
      output: 1093,
      reasoning: 472,
      cacheRead: 45824,
      cacheWrite: 0,
      total: 94056,
      model: 'gpt-5.3-codex',
      providerID: 'openai',
      assistantMessageCount: 2,
    })
  })

  test('sums assistant tokens when the session has no user message', () => {
    const sessionId = 'ses_no_user'
    const events = [
      assistantEvent({
        sessionId,
        messageId: 'msg_asst_1',
        parentID: 'msg_missing',
        created: 2,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    ]

    expect(getLatestTurnTokenUsage({ events, sessionId })).toEqual({
      input: 100,
      output: 10,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 110,
      cost: 0,
      model: 'gpt-5.3-codex',
      providerID: 'openai',
      assistantMessageCount: 1,
      userMessageId: undefined,
    })
  })
})

describe('getIdleTokenUsageDelta', () => {
  function idleEvent(sessionId: string): EventBufferEntry {
    return eventEntry({
      type: 'session.idle',
      properties: { sessionID: sessionId },
    })
  }

  test('emits the first idle snapshot and skips a later idle with the same tokens', () => {
    const sessionId = 'ses_delta'
    const events = [
      eventEntry({
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: 'msg_user_1',
            sessionID: sessionId,
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: {
              providerID: 'openai',
              modelID: 'gpt-5.3-codex',
            },
          },
        },
      }),
      eventEntry({
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: 'msg_asst_1',
            sessionID: sessionId,
            role: 'assistant',
            time: { created: 2, completed: 3 },
            parentID: 'msg_user_1',
            modelID: 'gpt-5.3-codex',
            providerID: 'openai',
            mode: 'build',
            agent: 'build',
            path: { cwd: '/test', root: '/test' },
            cost: 0,
            tokens: {
              input: 10,
              output: 5,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish: 'stop',
          },
        },
      }),
      idleEvent(sessionId),
      idleEvent(sessionId),
    ]

    const firstIdleIndex = events.length - 2
    const secondIdleIndex = events.length - 1
    expect(getIdleTokenUsageDelta({
      events,
      sessionId,
      idleEventIndex: firstIdleIndex,
    })).toMatchObject({
      total: 15,
    })
    expect(getIdleTokenUsageDelta({
      events,
      sessionId,
      idleEventIndex: secondIdleIndex,
    })).toBeUndefined()
  })

  test('emits the growth after an early idle that saw zero tokens', () => {
    const sessionId = 'ses_late_tokens'
    const events = [
      eventEntry({
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: 'msg_user_1',
            sessionID: sessionId,
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: {
              providerID: 'openai',
              modelID: 'gpt-5.3-codex',
            },
          },
        },
      }),
      eventEntry({
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: 'msg_asst_1',
            sessionID: sessionId,
            role: 'assistant',
            time: { created: 2 },
            parentID: 'msg_user_1',
            modelID: 'gpt-5.3-codex',
            providerID: 'openai',
            mode: 'build',
            agent: 'build',
            path: { cwd: '/test', root: '/test' },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        },
      }),
      idleEvent(sessionId),
      eventEntry({
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: 'msg_asst_1',
            sessionID: sessionId,
            role: 'assistant',
            time: { created: 2, completed: 4 },
            parentID: 'msg_user_1',
            modelID: 'gpt-5.3-codex',
            providerID: 'openai',
            mode: 'build',
            agent: 'build',
            path: { cwd: '/test', root: '/test' },
            cost: 0,
            tokens: {
              total: 20,
              input: 12,
              output: 8,
              reasoning: 3,
              cache: { read: 0, write: 0 },
            },
            finish: 'stop',
          },
        },
      }),
      idleEvent(sessionId),
    ]

    expect(getIdleTokenUsageDelta({
      events,
      sessionId,
      idleEventIndex: 2,
    })).toBeUndefined()
    expect(getIdleTokenUsageDelta({
      events,
      sessionId,
      idleEventIndex: events.length - 1,
    })).toMatchObject({
      input: 12,
      output: 8,
      reasoning: 3,
      total: 20,
    })
  })

  test('counts child session assistant tokens without a user message.updated', () => {
    const childSessionId = 'ses_task_child'
    const events = [
      eventEntry({
        type: 'message.updated',
        properties: {
          sessionID: childSessionId,
          info: {
            id: 'msg_child_asst_1',
            sessionID: childSessionId,
            role: 'assistant',
            time: { created: 2, completed: 3 },
            parentID: 'msg_child_user_missing',
            modelID: 'gpt-5.3-codex',
            providerID: 'openai',
            mode: 'general',
            agent: 'general',
            path: { cwd: '/test', root: '/test' },
            cost: 0.02,
            tokens: {
              total: 40,
              input: 30,
              output: 10,
              reasoning: 4,
              cache: { read: 0, write: 0 },
            },
            finish: 'stop',
          },
        },
      }),
      idleEvent(childSessionId),
    ]

    expect(getIdleTokenUsageDelta({
      events,
      sessionId: childSessionId,
      idleEventIndex: events.length - 1,
    })).toMatchObject({
      input: 30,
      output: 10,
      reasoning: 4,
      total: 40,
      cost: 0.02,
      assistantMessageCount: 1,
    })
  })

  test('falls back to session.updated Session.tokens for a child with no message.updated', () => {
    const childSessionId = 'ses_task_child_session_tokens'
    const events = [
      eventEntry({
        type: 'session.updated',
        properties: {
          sessionID: childSessionId,
          info: {
            id: childSessionId,
            slug: 'child',
            projectID: 'prj_1',
            directory: '/test',
            parentID: 'ses_main',
            title: 'child task',
            version: '1',
            cost: 0.05,
            tokens: {
              input: 100,
              output: 20,
              reasoning: 8,
              cache: { read: 4, write: 1 },
            },
            time: { created: 1, updated: 2 },
          },
        },
      }),
      idleEvent(childSessionId),
    ]

    expect(getIdleTokenUsageDelta({
      events,
      sessionId: childSessionId,
      idleEventIndex: events.length - 1,
    })).toMatchObject({
      input: 100,
      output: 20,
      reasoning: 8,
      cacheRead: 4,
      cacheWrite: 1,
      total: 133,
      cost: 0.05,
    })
  })

  test('does not re-emit child tokens at parent idle after the child already idled', () => {
    const childSessionId = 'ses_task_child_dedupe'
    const events = [
      eventEntry({
        type: 'message.updated',
        properties: {
          sessionID: childSessionId,
          info: {
            id: 'msg_child_asst_1',
            sessionID: childSessionId,
            role: 'assistant',
            time: { created: 2, completed: 3 },
            parentID: 'msg_child_user_missing',
            modelID: 'gpt-5.3-codex',
            providerID: 'openai',
            mode: 'general',
            agent: 'general',
            path: { cwd: '/test', root: '/test' },
            cost: 0,
            tokens: {
              total: 40,
              input: 30,
              output: 10,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish: 'stop',
          },
        },
      }),
      idleEvent(childSessionId),
      idleEvent('ses_main'),
    ]

    expect(getIdleTokenUsageDelta({
      events,
      sessionId: childSessionId,
      idleEventIndex: 1,
    })).toMatchObject({ total: 40 })
    expect(getIdleTokenUsageDelta({
      events,
      sessionId: childSessionId,
      idleEventIndex: 2,
    })).toBeUndefined()
  })
})

describe('task child session token tracking', () => {
  function idleEvent(sessionId: string): EventBufferEntry {
    return eventEntry({
      type: 'session.idle',
      properties: { sessionID: sessionId },
    })
  }

  test('isDerivedChildSession is true from session.created parentID before task metadata', () => {
    const mainSessionId = 'ses_main'
    const childSessionId = 'ses_child'
    const events = [
      eventEntry({
        type: 'session.created',
        properties: {
          sessionID: childSessionId,
          info: {
            id: childSessionId,
            slug: 'child',
            projectID: 'prj_1',
            directory: '/test',
            parentID: mainSessionId,
            title: 'explore files',
            version: '1',
            time: { created: 1, updated: 1 },
          },
        },
      }),
    ]

    expect(isDerivedChildSession({
      events,
      mainSessionId,
      candidateSessionId: childSessionId,
    })).toBe(true)
    expect(isDerivedChildSession({
      events,
      mainSessionId,
      candidateSessionId: 'ses_unrelated',
    })).toBe(false)
  })

  test('main idle also returns child session ids so their tokens can be tracked', () => {
    const mainSessionId = 'ses_main'
    const childSessionId = 'ses_child'
    const events = [
      eventEntry({
        type: 'session.created',
        properties: {
          sessionID: childSessionId,
          info: {
            id: childSessionId,
            slug: 'child',
            projectID: 'prj_1',
            directory: '/test',
            parentID: mainSessionId,
            title: 'child task',
            version: '1',
            time: { created: 1, updated: 1 },
          },
        },
      }),
      eventEntry({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_task',
            sessionID: mainSessionId,
            messageID: 'msg_asst',
            type: 'tool',
            callID: 'call_task',
            tool: 'task',
            state: {
              status: 'running',
              input: { subagent_type: 'general' },
              metadata: { sessionId: childSessionId },
            },
          },
        },
      }),
      idleEvent(mainSessionId),
    ]

    expect(getTokenUsageSessionIdsForIdle({
      events,
      mainSessionId,
      idleSessionId: mainSessionId,
    })).toEqual([mainSessionId, childSessionId])
    expect(getTokenUsageSessionIdsForIdle({
      events,
      mainSessionId,
      idleSessionId: childSessionId,
    })).toEqual([childSessionId])
  })
})

describe('question waits for preceding text-end', () => {
  const sessionId = 'ses_question_text'
  const messageId = 'msg_asst_question'
  const questionId = 'que_1'

  const textStart = eventEntry({
    type: 'message.part.updated',
    properties: {
      sessionID: sessionId,
      part: {
        id: 'prt_text',
        sessionID: sessionId,
        messageID: messageId,
        type: 'text',
        text: '',
        time: { start: 1 },
      },
    },
  })
  const questionAsked = eventEntry({
    type: 'question.asked',
    properties: {
      id: questionId,
      sessionID: sessionId,
      questions: [{
        question: 'What next?',
        header: 'Next step',
        options: [
          { label: 'Commit', description: 'Commit these files' },
        ],
      }],
      tool: {
        messageID: messageId,
        callID: 'call_question',
      },
    },
  })
  const textEnd = eventEntry({
    type: 'message.part.updated',
    properties: {
      sessionID: sessionId,
      part: {
        id: 'prt_text',
        sessionID: sessionId,
        messageID: messageId,
        type: 'text',
        text: 'Done callout',
        time: { start: 1, end: 2 },
      },
    },
  })
  const questionError = eventEntry({
    type: 'message.part.updated',
    properties: {
      sessionID: sessionId,
      part: {
        id: 'prt_question',
        sessionID: sessionId,
        messageID: messageId,
        type: 'tool',
        tool: 'question',
        callID: 'call_question',
        state: {
          status: 'error',
          error: 'Aborted',
          time: { start: 2, end: 3 },
        },
      },
    },
  })

  test('text is not ready when question.asked arrives before time.end', () => {
    const events = [textStart, questionAsked]
    expect(isAssistantTextReadyForQuestion({
      events,
      sessionId,
      messageId,
    })).toBe(false)
    expect(deriveLatestUnansweredQuestion({
      events,
      sessionId,
    })).toMatchObject({
      id: questionId,
      tool: { messageID: messageId },
    })
  })

  test('text is ready after time.end, and still unanswered', () => {
    const events = [textStart, questionAsked, textEnd]
    expect(isAssistantTextReadyForQuestion({
      events,
      sessionId,
      messageId,
    })).toBe(true)
    expect(deriveLatestUnansweredQuestion({
      events,
      sessionId,
    })?.id).toBe(questionId)
  })

  test('no text part means the question is ready immediately', () => {
    const events = [questionAsked]
    expect(isAssistantTextReadyForQuestion({
      events,
      sessionId,
      messageId,
    })).toBe(true)
  })

  test('aborted question is not unanswered', () => {
    const events = [textStart, questionAsked, textEnd, questionError]
    expect(deriveLatestUnansweredQuestion({
      events,
      sessionId,
    })).toBeUndefined()
  })

  test('question from an older user turn is not unanswered', () => {
    const firstUser = eventEntry({
      type: 'message.updated',
      properties: {
        sessionID: sessionId,
        info: {
          id: 'msg_user_first',
          sessionID: sessionId,
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: {
            providerID: 'deterministic-provider',
            modelID: 'deterministic-v2',
          },
        },
      },
    })
    const questionAssistant = eventEntry({
      type: 'message.updated',
      properties: {
        sessionID: sessionId,
        info: {
          id: messageId,
          sessionID: sessionId,
          role: 'assistant',
          time: { created: 2 },
          parentID: 'msg_user_first',
          modelID: 'deterministic-v2',
          providerID: 'deterministic-provider',
          mode: 'build',
          agent: 'build',
          path: { cwd: '/test', root: '/test' },
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    })
    const nextUser = eventEntry({
      type: 'message.updated',
      properties: {
        sessionID: sessionId,
        info: {
          id: 'msg_user_commit',
          sessionID: sessionId,
          role: 'user',
          time: { created: 3 },
          agent: 'build',
          model: {
            providerID: 'deterministic-provider',
            modelID: 'deterministic-v2',
          },
        },
      },
    })
    const events = [
      firstUser,
      questionAssistant,
      textStart,
      questionAsked,
      textEnd,
      nextUser,
    ]

    expect(deriveLatestUnansweredQuestion({
      events,
      sessionId,
    })).toBeUndefined()
  })
})
