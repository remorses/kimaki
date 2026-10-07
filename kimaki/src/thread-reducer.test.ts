// Reducer core cases on recorded OpenCode V2 events: banner, text, footer,
// typing, and the explicit list of event types that produce effects.

import type { JsonValue, V2Event } from '@opencode/client'
import { expect, test } from 'vitest'

import { emptyView, reduce } from './thread-reducer.ts'
import { DEFAULT_PREFS, effectLines, loadFixture, replay, rootSessionId } from './test/replay.ts'

test('text-only turn: banner, text, typing, footer with context percent', () => {
  const events = loadFixture('tools.events.jsonl').filter((event) => !event.type.startsWith('session.tool.'))
  const { view, effects } = replay({ events })
  expect(effects).toMatchInlineSnapshot(`
    [
      {
        "on": true,
        "type": "typing",
      },
      {
        "text": "-# *using openai/gpt-6-luna ⋅ build*",
        "type": "send",
      },
      {
        "blankLineBefore": false,
        "text": "Done. \`tmp-events/hello.txt\` contains \`hello world\`.",
        "type": "markdown",
      },
      {
        "on": false,
        "type": "typing",
      },
      {
        "agent": "build",
        "contextPercent": 6,
        "directory": "/project",
        "durationMs": 17597,
        "model": {
          "id": "gpt-6-luna",
          "providerID": "openai",
        },
        "notify": true,
        "type": "footer",
      },
    ]
  `)
  expect(view.turn).toBe(null)
})

test('execution failure shows the error and no footer, interrupt shows nothing', () => {
  const events = loadFixture('abort.events.jsonl')
  const sessionID = rootSessionId(events)
  const started = events.find((event) => event.type === 'session.execution.started')!
  const view = emptyView({ sessionId: sessionID, channelId: 'channel', directory: '/project', isNew: false })
  const busy = reduce({ view, event: started, prefs: DEFAULT_PREFS }).view
  const failed = reduce({
    view: busy,
    event: {
      id: 'evt_failed',
      created: started.created + 1_000,
      type: 'session.execution.failed',
      durable: { aggregateID: sessionID, seq: 99, version: 1 },
      data: { sessionID, error: { type: 'provider.error', message: 'rate limited by provider' } },
    },
    prefs: DEFAULT_PREFS,
  })
  expect(failed.effects).toMatchInlineSnapshot(`
    [
      {
        "on": false,
        "type": "typing",
      },
      {
        "notify": true,
        "text": "✗ rate limited by provider",
        "type": "send",
      },
    ]
  `)
  expect(replay({ events, view }).effects).toMatchInlineSnapshot(`
    [
      {
        "on": true,
        "type": "typing",
      },
      {
        "text": "-# ┣ shell _sleep 30 && echo never_",
        "type": "send",
      },
      {
        "on": false,
        "type": "typing",
      },
      {
        "on": true,
        "type": "typing",
      },
      {
        "blankLineBefore": false,
        "text": "resumed after abort",
        "type": "markdown",
      },
      {
        "on": false,
        "type": "typing",
      },
      {
        "agent": "build",
        "contextPercent": 6,
        "directory": "/project",
        "durationMs": 1387,
        "model": {
          "id": "gpt-6-luna",
          "providerID": "openai",
        },
        "notify": true,
        "type": "footer",
      },
    ]
  `)
})

test('only these event types produce effects for the root session', () => {
  const files = [
    'tools.events.jsonl',
    'abort.events.jsonl',
    'queue-plain.events.jsonl',
    'shell.events.jsonl',
    'switch-model.events.jsonl',
    'fork-compact.events.jsonl',
    'worktree.events.jsonl',
  ]
  const producing = new Set<string>()
  const silent = new Set<string>()
  for (const file of files) {
    const events = loadFixture(file)
    const sessionId = rootSessionId(events)
    let view = emptyView({ sessionId, channelId: 'channel', directory: '/project', isNew: true })
    for (const event of events) {
      const result = reduce({ view, event, prefs: DEFAULT_PREFS })
      view = result.view
      ;(result.effects.length > 0 ? producing : silent).add(event.type)
    }
  }
  expect([...producing].sort()).toMatchInlineSnapshot(`
    [
      "session.execution.interrupted",
      "session.execution.started",
      "session.execution.succeeded",
      "session.inbox.delivered",
      "session.inbox.enqueued",
      "session.shell.ended",
      "session.shell.started",
      "session.step.started",
      "session.text.ended",
      "session.tool.called",
      "session.tool.failed",
    ]
  `)
  expect([...silent].filter((type) => !producing.has(type)).sort()).toMatchInlineSnapshot(`
    [
      "agent.updated",
      "command.updated",
      "integration.updated",
      "model.updated",
      "plugin.updated",
      "project.updated",
      "provider.updated",
      "reference.updated",
      "server.connected",
      "session.agent.selected",
      "session.compaction.delta",
      "session.compaction.ended",
      "session.compaction.started",
      "session.created",
      "session.forked",
      "session.instructions.updated",
      "session.model.selected",
      "session.renamed",
      "session.step.ended",
      "session.step.failed",
      "session.step.streamed",
      "session.text.delta",
      "session.text.started",
      "session.tool.input.ended",
      "session.tool.input.started",
      "session.tool.progress",
      "session.tool.success",
      "session.usage.updated",
      "shell.created",
      "shell.deleted",
      "shell.exited",
      "skill.updated",
      "vcs.branch.updated",
      "websearch.updated",
      "worktree.updated",
    ]
  `)
})

test('retry notices are throttled to one per 10s', () => {
  const events = loadFixture('abort.events.jsonl')
  const sessionID = rootSessionId(events)
  const view = emptyView({ sessionId: sessionID, channelId: 'channel', directory: '/project', isNew: false })
  const retry = (created: number, attempt: number): V2Event => ({
    id: `evt_retry_${attempt}`,
    created,
    type: 'session.retry.scheduled',
    durable: { aggregateID: sessionID, seq: attempt, version: 1 },
    data: {
      sessionID,
      assistantMessageID: 'msg_a',
      attempt,
      at: created + 4_500,
      error: { type: 'provider.rate_limit', message: 'rate limited' },
    },
  })
  const { effects } = replay({ events: [retry(1_000, 1), retry(6_000, 2), retry(12_000, 3)], view })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "-# ⬦ retrying in 5s (attempt 1): rate limited",
      "-# ⬦ retrying in 5s (attempt 3): rate limited",
    ]
  `)
})

test('cache miss notice when the cached prefix shrinks, e.g. after the cache TTL', () => {
  const events = loadFixture('tools.events.jsonl')
  const sessionId = rootSessionId(events)
  const steps = events.flatMap((event, index) => (event.type === 'session.step.ended' && event.data.sessionID === sessionId ? [index] : []))
  const lastIndex = steps.at(-1)!
  const last = events[lastIndex]
  if (last?.type !== 'session.step.ended') return expect.fail('fixture has no root step.ended')
  // Same turn, but the last request found nothing in cache 10 minutes later.
  const missed = events.map((event, index) =>
    index === lastIndex ? { ...last, created: last.created + 600_000, data: { ...last.data, tokens: { ...last.data.tokens, cache: { read: 0, write: 0 } } } } : event,
  )
  expect(effectLines(replay({ events: missed }).effects).filter((line) => line.includes('cache'))).toMatchInlineSnapshot(`
    [
      "\\n-# ⬦ prompt cache miss: 0 of 25k tokens cached, 10m 1s after the last request",
    ]
  `)
  expect(effectLines(replay({ events }).effects).filter((line) => line.includes('cache'))).toEqual([])
})

test('snapshot closes the ack of an item promoted while disconnected, without an echo', () => {
  const events = loadFixture('queue-plain.events.jsonl')
  const index = events.findIndex((event) => event.type === 'session.inbox.enqueued' && event.data.item.delivery === 'queue')
  const enqueued = events[index]
  if (enqueued?.type !== 'session.inbox.enqueued' || enqueued.data.item.type !== 'user') return expect.fail('fixture has no queued user item')
  const { view } = replay({ events: events.slice(0, index + 1) })
  expect(view.inbox[0]?.acked).toBe(true)
  const snapshot = {
    type: 'kimaki.snapshot' as const,
    at: enqueued.created,
    directory: null,
    activeSessionIds: [view.sessionId],
    sessions: [{
      sessionId: view.sessionId,
      inbox: [{ ...enqueued.data.item, id: enqueued.data.inboxID, sessionID: view.sessionId, time: { created: enqueued.created }, delivery: 'steer' as const }],
      forms: [],
      permissions: [],
    }],
  }
  const hydrated = reduce({ view, event: snapshot, prefs: DEFAULT_PREFS })
  expect(effectLines(hydrated.effects)).toMatchInlineSnapshot(`
    [
      "[edit queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# Queued message sent",
    ]
  `)
  expect(hydrated.effects.map((effect) => effect.type)).toEqual(['edit'])
  expect(hydrated.view.inbox[0]?.delivery).toBe('steer')
  expect(reduce({ view: hydrated.view, event: snapshot, prefs: DEFAULT_PREFS }).effects).toEqual([])
})

test('execute: final metadata shows inner calls whose progress was missed, then failures', () => {
  const events = loadFixture('abort.events.jsonl')
  const sessionID = rootSessionId(events)
  const view = emptyView({ sessionId: sessionID, channelId: 'channel', directory: '/project', isNew: false })
  const base = { created: 1_000 }
  const durable = <V extends number>(version: V) => ({ aggregateID: sessionID, seq: 1, version })
  const call = { sessionID, assistantMessageID: 'msg_a', id: 'call_1' }
  const toolCalls: JsonValue[] = [
    { tool: 'opencode.models', status: 'completed', input: { query: 'gpt' } },
    { tool: 'opencode.session_move', status: 'error', input: { directory: '/wt' } },
  ]
  const progress = (count: number): V2Event => ({ ...base, id: `evt_progress_${count}`, type: 'session.tool.progress', data: { ...call, metadata: { toolCalls: toolCalls.slice(0, count) } } })
  const { effects } = replay({
    view,
    events: [
      { ...base, durable: durable(1), id: 'evt_input', type: 'session.tool.input.started', data: { ...call, name: 'execute' } },
      { ...base, durable: durable(1), id: 'evt_called', type: 'session.tool.called', data: { ...call, executed: false, input: { code: 'x', description: 'Move to worktree' } } },
      progress(1),
      progress(1),
      {
        ...base,
        durable: durable(2),
        id: 'evt_success',
        type: 'session.tool.success',
        data: { ...call, executed: true, metadata: { toolCalls, error: true }, content: [{ type: 'text', text: 'Error: no such directory\nmore' }] },
      },
    ],
  })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "-# ┣ execute _Move to worktree_",
      "-# ┣ execute.opencode.models _gpt_",
      "-# ┣ execute.opencode.session\\_move _/wt_",
      "-# ⨯ execute.opencode.session\\_move _failed_",
      "-# ⨯ execute _Error: no such directory_",
    ]
  `)
})
