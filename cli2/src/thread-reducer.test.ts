// Reducer core cases on recorded OpenCode V2 events: banner, text, footer,
// typing, and the explicit list of event types that produce effects.

import type { V2Event } from '@opencode/client'
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
        "text": "-# *project ⋅ main ⋅ 17s ⋅ 6% ⋅ gpt-6-luna*",
        "type": "send",
      },
    ]
  `)
  expect(view.turn).toBe(null)
})

test('execution failure shows the error and no footer, interrupt shows nothing', () => {
  const events = loadFixture('abort.events.jsonl')
  const sessionID = rootSessionId(events)
  const started = events.find((event) => event.type === 'session.execution.started')!
  const view = emptyView({ threadId: 'thread', sessionId: sessionID, folder: 'project', isNew: false })
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
        "text": "-# *project ⋅ main ⋅ 1s ⋅ 6% ⋅ gpt-6-luna*",
        "type": "send",
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
    let view = emptyView({ threadId: 'thread', sessionId, folder: 'project', isNew: true })
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
      "session.inbox.delivered",
      "session.inbox.enqueued",
      "session.instructions.updated",
      "session.model.selected",
      "session.renamed",
      "session.shell.ended",
      "session.shell.started",
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
  const view = emptyView({ threadId: 'thread', sessionId: sessionID, folder: 'project', isNew: false })
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
