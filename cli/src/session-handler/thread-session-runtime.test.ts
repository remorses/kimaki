// Tests durable native event recovery and terminal analytics derivation.

import type { V2Event } from '@opencode/client'
import { describe, expect, test } from 'vitest'
import {
  buildPreparedAdmissionValue,
  orderNativeRecoveryEvents,
} from './thread-session-runtime.js'
import type { DiscordFileAttachment } from '../message-formatting.js'
import {
  applyDiscordProjectionActions,
  createDiscordProjectionState,
  projectDiscordActions,
} from './discord-event-projection.js'
import {
  deriveNativeExecutionTerminalAnalytics,
  getNativeDurableIdentity,
  hasSeenNativeDurableEvent,
  type EventBufferEntry,
} from './event-stream-state.js'

let eventSequence = 0

describe('prompt admission preparation', () => {
  test('direct and local queue paths preserve the complete prepared value', () => {
    const images: DiscordFileAttachment[] = [
      {
        type: 'file',
        filename: 'diagram.png',
        url: 'https://cdn.example.test/diagram.png',
        sourceUrl: 'https://discord.example.test/diagram.png',
        mime: 'image/png',
      },
    ]
    const common = {
      client: { session: {} },
      sessionId: 'ses_admission',
      prompt: 'Inspect this diagram',
      syntheticContext: '<discord-user user-id="user-1" message-id="message-1" thread-id="thread-1" />',
      images,
      agent: 'plan',
      model: { providerID: 'openai', modelID: 'gpt-5.3-codex' },
      variant: 'high',
      inputKind: 'prompt' as const,
      source: 'cli' as const,
    }
    const direct = buildPreparedAdmissionValue({
      ...common,
      delivery: 'steer',
      ingressMode: 'direct',
    })
    const localQueue = buildPreparedAdmissionValue({
      ...common,
      delivery: 'queue',
      ingressMode: 'local_queue',
    })

    expect({
      direct: { ...direct, client: '[client]' },
      localQueue: { ...localQueue, client: '[client]' },
    }).toMatchInlineSnapshot(`
      {
        "direct": {
          "agent": "plan",
          "client": "[client]",
          "delivery": "steer",
          "images": [
            {
              "filename": "diagram.png",
              "mime": "image/png",
              "sourceUrl": "https://discord.example.test/diagram.png",
              "type": "file",
              "url": "https://cdn.example.test/diagram.png",
            },
          ],
          "ingressMode": "direct",
          "inputKind": "prompt",
          "model": {
            "modelID": "gpt-5.3-codex",
            "providerID": "openai",
          },
          "sessionId": "ses_admission",
          "source": "cli",
          "text": "Inspect this diagram

      **The following images are already included in this message as inline content (do not use Read tool on these):**
      - https://discord.example.test/diagram.png
      <discord-user user-id="user-1" message-id="message-1" thread-id="thread-1" />",
          "variant": "high",
        },
        "localQueue": {
          "agent": "plan",
          "client": "[client]",
          "delivery": "queue",
          "images": [
            {
              "filename": "diagram.png",
              "mime": "image/png",
              "sourceUrl": "https://discord.example.test/diagram.png",
              "type": "file",
              "url": "https://cdn.example.test/diagram.png",
            },
          ],
          "ingressMode": "local_queue",
          "inputKind": "prompt",
          "model": {
            "modelID": "gpt-5.3-codex",
            "providerID": "openai",
          },
          "sessionId": "ses_admission",
          "source": "cli",
          "text": "Inspect this diagram

      **The following images are already included in this message as inline content (do not use Read tool on these):**
      - https://discord.example.test/diagram.png
      <discord-user user-id="user-1" message-id="message-1" thread-id="thread-1" />",
          "variant": "high",
        },
      }
    `)
  })
})

function durable(sessionID: string) {
  return {
    aggregateID: sessionID,
    seq: ++eventSequence,
    version: 1 as const,
  }
}

function executionStarted(
  sessionID: string,
  created: number,
): Extract<V2Event, { type: 'session.execution.started' }> {
  return {
    id: `evt_${++eventSequence}`,
    created,
    type: 'session.execution.started',
    durable: durable(sessionID),
    data: { sessionID },
  }
}

function stepStarted(sessionID: string, created: number): V2Event {
  return {
    id: `evt_${++eventSequence}`,
    created,
    type: 'session.step.started',
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: 'msg_assistant',
      agent: 'build',
      model: { providerID: 'openai', id: 'gpt-5.3-codex' },
    },
  }
}

function stepEnded(sessionID: string, created: number): V2Event {
  return {
    id: `evt_${++eventSequence}`,
    created,
    type: 'session.step.ended',
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: 'msg_assistant',
      finish: 'stop',
      cost: 0.04,
      tokens: {
        input: 10,
        output: 4,
        reasoning: 2,
        cache: { read: 3, write: 1 },
      },
    },
  }
}

function stepFailed(
  sessionID: string,
  created: number,
): Extract<V2Event, { type: 'session.step.failed' }> {
  return {
    id: `evt_${++eventSequence}`,
    created,
    type: 'session.step.failed',
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: 'msg_assistant',
      error: { type: 'provider', message: 'Provider failed' },
      cost: 0.04,
      tokens: {
        input: 10,
        output: 4,
        reasoning: 2,
        cache: { read: 3, write: 1 },
      },
    },
  }
}

function textEnded(sessionID: string, created: number): Extract<V2Event, { type: 'session.text.ended' }> {
  return {
    id: `evt_${++eventSequence}`,
    created,
    type: 'session.text.ended',
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: 'msg_assistant',
      ordinal: 0,
      text: 'Done',
    },
  }
}

function terminalEvent({
  sessionID,
  created,
  type,
}: {
  sessionID: string
  created: number
  type:
    | 'session.execution.succeeded'
    | 'session.execution.failed'
    | 'session.execution.interrupted'
}): Extract<V2Event, { type: typeof type }> {
  const common = {
    id: `evt_${++eventSequence}`,
    created,
    durable: durable(sessionID),
  }
  if (type === 'session.execution.failed') {
    return {
      ...common,
      type,
      data: {
        sessionID,
        error: { type: 'provider', message: 'Provider failed' },
      },
    }
  }
  if (type === 'session.execution.interrupted') {
    return {
      ...common,
      type,
      data: { sessionID, reason: 'user' },
    }
  }
  return { ...common, type, data: { sessionID } }
}

describe('native reconnect recovery', () => {
  test('orders ascending main and subagent logs chronologically', () => {
    const mainStart = executionStarted('ses_main', 100)
    const childStart = executionStarted('ses_child', 110)
    const childEnd = terminalEvent({
      sessionID: 'ses_child',
      created: 120,
      type: 'session.execution.succeeded',
    })
    const mainEnd = terminalEvent({
      sessionID: 'ses_main',
      created: 130,
      type: 'session.execution.succeeded',
    })

    expect(orderNativeRecoveryEvents([
      mainStart,
      mainEnd,
      childStart,
      childEnd,
    ]).map((event) => [event.created, event.durable.aggregateID])).toEqual([
      [100, 'ses_main'],
      [110, 'ses_child'],
      [120, 'ses_child'],
      [130, 'ses_main'],
    ])
  })

  test('reconnect log overlap processes terminal E once', () => {
    const sessionID = 'ses_main'
    const started = executionStarted(sessionID, 100)
    const visible = textEnded(sessionID, 200)
    const replayed = terminalEvent({
      sessionID,
      created: 300,
      type: 'session.execution.succeeded',
    })
    const live = {
      ...replayed,
      id: 'evt_live_overlap',
    }
    const reconnectLog = orderNativeRecoveryEvents([started, visible, replayed])
    const ingress = [...reconnectLog, live]

    let state = createDiscordProjectionState()
    const events: EventBufferEntry[] = []
    const actions = ingress.flatMap((event) => {
      if (hasSeenNativeDurableEvent({ events, event })) return []
      events.push({ event, timestamp: event.created })
      const next = projectDiscordActions({
        event,
        events,
        projectedParts: state.parts,
        pendingForms: state.pendingForms,
        shownFormIds: state.shownFormIds,
        mainSessionId: sessionID,
        verbosity: 'tools_and_text',
        deliveredPartIds: new Set(),
        largeOutputThresholdTokens: 3_000,
      })
      state = applyDiscordProjectionActions({ state, actions: next })
      return next
    })
    const terminalActions = actions.filter((action) => {
      return action.type === 'send-footer'
        || action.type === 'record-terminal-analytics'
        || action.type === 'complete-scheduled-task'
        || action.type === 'drain-queue'
        || action.type === 'reset-run'
    })

    expect(events.map((entry) => getNativeDurableIdentity(entry.event))).toEqual([
      getNativeDurableIdentity(started),
      getNativeDurableIdentity(visible),
      getNativeDurableIdentity(replayed),
    ])
    expect(terminalActions.map((action) => action.type)).toEqual([
      'complete-scheduled-task',
      'record-terminal-analytics',
      'send-footer',
      'reset-run',
      'drain-queue',
    ])
  })
})

describe('native terminal analytics', () => {
  test.each([
    ['session.execution.succeeded', 'succeeded'],
    ['session.execution.failed', 'failed'],
    ['session.execution.interrupted', 'interrupted'],
  ] as const)('records %s as %s', (type, outcome) => {
    const sessionID = `ses_${outcome}`
    const terminal = terminalEvent({ sessionID, created: 4_100, type })
    const events: EventBufferEntry[] = [
      { event: executionStarted(sessionID, 1_000), timestamp: 1_000 },
      { event: stepStarted(sessionID, 2_000), timestamp: 2_000 },
      {
        event: outcome === 'succeeded'
          ? stepEnded(sessionID, 3_000)
          : stepFailed(sessionID, 3_000),
        timestamp: 3_000,
      },
      { event: terminal, timestamp: 4_100 },
    ]

    expect(deriveNativeExecutionTerminalAnalytics({
      events,
      event: terminal,
    })).toMatchObject({
      outcome,
      durationSec: 3,
      usage: {
        input: 10,
        output: 4,
        reasoning: 2,
        cacheRead: 3,
        cacheWrite: 1,
        total: 20,
        cost: 0.04,
        assistantMessageCount: 1,
      },
    })
  })
})
