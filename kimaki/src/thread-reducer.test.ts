// Reducer core cases on recorded OpenCode V2 events: banner, text, footer,
// typing, and the explicit list of event types that produce effects.

import type { JsonValue, V2Event } from '@opencode/client'
import { expect, test } from 'vitest'

import { emptyView, reduce, type ThreadEvent } from './thread-reducer.ts'
import { DEFAULT_PREFS, effectLines, loadFixture, replay, rootSessionId } from './test/replay.ts'

test('text-only turn: banner, text, typing, footer with context percent', () => {
  const events = loadFixture('tools.events.jsonl').filter((event) => !event.type.startsWith('session.tool.'))
  const { view, effects } = replay({ events })
  expect(effects).toMatchInlineSnapshot(`
    [
      {
        "echo": true,
        "text": "-# » **user:** Do these steps with tools, one by one: 1) run \`ls cli/src | head -5\` with bash, 2) write a file tmp-events/hello.txt containing "hello", 3) edit that file to replace hello with "hello world", 4) glob for **/*.txt under tmp-events, 5) read the file. Then reply with one short line.",
        "type": "send",
      },
      {
        "on": true,
        "type": "typing",
      },
      {
        "text": "-# *using openai/gpt-6-luna low ⋅ build*",
        "type": "send",
      },
      {
        "blankLineBefore": false,
        "replyTo": null,
        "text": "Done. \`tmp-events/hello.txt\` contains \`hello world\`.",
        "type": "markdown",
      },
      {
        "on": false,
        "type": "typing",
      },
      {
        "agent": "build",
        "channelId": "channel",
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
      {
        "idle": 1790766377050,
        "sessionId": "ses_f0e01dc7bffelNzR27kKXbTrdG",
        "type": "viewed",
      },
    ]
  `)
  expect(view.turn).toBe(null)
})

test('a turn that posts nothing visible ends without a footer', () => {
  const events = loadFixture('tools.events.jsonl')
  // Read-only tools are hidden at the default verbosity.
  const hiddenTools = new Set(events.flatMap((event) => (event.type === 'session.tool.input.started' && ['read', 'glob'].includes(event.data.name) ? [event.data.id] : [])))
  const quiet = events.filter((event) => {
    if (event.type.startsWith('session.text.')) return false
    if (!event.type.startsWith('session.tool.')) return true
    const data: { readonly [key: string]: JsonValue | undefined } = event.data
    return typeof data['id'] === 'string' && hiddenTools.has(data['id'])
  })
  const footers = (input: ThreadEvent[]) => replay({ events: input }).effects.filter((effect) => effect.type === 'footer').length
  expect(hiddenTools.size).toBe(2)
  expect({ quiet: footers(quiet), normal: footers(events) }).toMatchInlineSnapshot(`
    {
      "normal": 1,
      "quiet": 0,
    }
  `)
})

test('any turn that answers IDLE posts no text and no footer', () => {
  const turn = loadFixture('tools.events.jsonl').filter((event) => !event.type.startsWith('session.tool.'))
  const idle = turn.map((event) => (event.type === 'session.text.ended' ? { ...event, data: { ...event.data, text: 'IDLE' } } : event))
  const visible = replay({ events: idle }).effects.filter((effect) => effect.type === 'markdown' || effect.type === 'footer')
  expect(visible).toEqual([])
})

test('a coordinator turn with tool lines but no text (or only IDLE) posts no footer; a thread turn does', () => {
  const events = loadFixture('tools.events.jsonl')
  const idle = events.map((event) => (event.type === 'session.text.ended' ? { ...event, data: { ...event.data, text: 'IDLE' } } : event))
  const silent = events.filter((event) => !event.type.startsWith('session.text.'))
  const sessionId = rootSessionId(events.filter((event): event is V2Event => !event.type.startsWith('kimaki.')))
  const shown = (input: ThreadEvent[], coordinator: boolean) =>
    replay({ events: input, view: emptyView({ sessionId, channelId: 'channel', directory: '/project', isNew: true, coordinator }) }).effects.flatMap((effect) =>
      effect.type === 'footer' ? ['footer'] : effect.type === 'send' && effect.text.includes('┣') ? ['tool'] : [],
    )
  expect({ coordinatorIdle: shown(idle, true), coordinatorNoText: shown(silent, true), threadIdle: shown(idle, false) }).toMatchInlineSnapshot(`
    {
      "coordinatorIdle": [
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
      ],
      "coordinatorNoText": [
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
      ],
      "threadIdle": [
        "tool",
        "tool",
        "tool",
        "tool",
        "tool",
        "footer",
      ],
    }
  `)
})

test('kimaki sleep in a turn makes its footer silent, the next turn notifies again', () => {
  const turn = loadFixture('tools.events.jsonl').filter((event) => !event.type.startsWith('session.tool.'))
  const end = turn.findIndex((event) => event.type === 'session.execution.succeeded')
  const slept = replay({ events: [...turn.slice(0, end), { type: 'kimaki.sleep' }, ...turn.slice(end)] })
  const next = replay({ events: turn, view: slept.view })
  const footers = [...slept.effects, ...next.effects].flatMap((effect) => (effect.type === 'footer' ? [effect.notify] : []))
  expect(footers).toMatchInlineSnapshot(`
    [
      false,
      true,
    ]
  `)
})

test('root model and agent switches after the banner show as subtext lines', () => {
  const events = loadFixture('switch-model.events.jsonl')
  const switches = events.filter((event) => event.type === 'session.model.selected' || event.type === 'session.agent.selected')
  // Before the first step the banner shows the model and agent; a re-select of the same model shows nothing.
  const sameModel = switches.flatMap((event) => (event.type === 'session.model.selected' ? [{ ...event, data: { ...event.data, previous: event.data.model } }] : []))
  const created = events.findIndex((event) => event.type === 'session.created')
  const lines = effectLines(replay({ events: [...events.slice(0, created + 1), ...switches, ...events.slice(created + 1), ...sameModel] }).effects)
  expect(lines.filter((line) => /Switched|using/.test(line))).toMatchInlineSnapshot(`
    [
      "-# *using openai/gpt-6-luna low ⋅ build*",
      "-# Switched model to GPT 6 Luna (medium)",
      "-# Switched agent to Plan",
    ]
  `)
})

test('execution failure shows the error and no footer, interrupt shows nothing', () => {
  const events = loadFixture('abort.events.jsonl')
  const sessionID = rootSessionId(events)
  const started = events.find((event) => event.type === 'session.execution.started')!
  const view = emptyView({ sessionId: sessionID, channelId: 'channel', directory: '/project', isNew: false, coordinator: false })
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
      {
        "idle": 1790766552199,
        "sessionId": "ses_f0dfeef78ffeZ3za5UGCaeop1t",
        "type": "viewed",
      },
    ]
  `)
  expect(replay({ events, view }).effects).toMatchInlineSnapshot(`
    [
      {
        "echo": true,
        "text": "-# » **user:** Run \`sleep 30 && echo never\` with bash, then summarize.",
        "type": "send",
      },
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
        "idle": 1790766554479,
        "sessionId": "ses_f0dfeef78ffeZ3za5UGCaeop1t",
        "type": "viewed",
      },
      {
        "echo": true,
        "text": "-# » **user:** Say only: resumed after abort.",
        "type": "send",
      },
      {
        "on": true,
        "type": "typing",
      },
      {
        "blankLineBefore": false,
        "replyTo": null,
        "text": "resumed after abort",
        "type": "markdown",
      },
      {
        "on": false,
        "type": "typing",
      },
      {
        "agent": "build",
        "channelId": "channel",
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
      {
        "idle": 1790766556670,
        "sessionId": "ses_f0dfeef78ffeZ3za5UGCaeop1t",
        "type": "viewed",
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
    let view = emptyView({ sessionId, channelId: 'channel', directory: '/project', isNew: true, coordinator: false })
    for (const event of events) {
      const result = reduce({ view, event, prefs: DEFAULT_PREFS })
      view = result.view
      ;(result.effects.length > 0 ? producing : silent).add(event.type)
    }
  }
  expect([...producing].sort()).toMatchInlineSnapshot(`
    [
      "session.agent.selected",
      "session.execution.interrupted",
      "session.execution.started",
      "session.execution.succeeded",
      "session.inbox.delivered",
      "session.inbox.enqueued",
      "session.model.selected",
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
      "session.compaction.delta",
      "session.compaction.ended",
      "session.compaction.started",
      "session.created",
      "session.forked",
      "session.instructions.updated",
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
  const view = emptyView({ sessionId: sessionID, channelId: 'channel', directory: '/project', isNew: false, coordinator: false })
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
      "-# retrying in 5s (attempt 1): rate limited",
      "-# retrying in 5s (attempt 3): rate limited",
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
  const withCache = (cache: { read: number; write: number }, input = last.data.tokens.input) =>
    events.map((event, index) =>
      index === lastIndex ? { ...last, created: last.created + 600_000, data: { ...last.data, tokens: { ...last.data.tokens, input, cache } } } : event,
    )
  const cacheLines = (stream: V2Event[]) => effectLines(replay({ events: stream }).effects).filter((line) => line.includes('cache'))
  // Everything was written again: a full loss.
  expect(cacheLines(withCache({ read: 0, write: 25_000 }, 0))).toMatchInlineSnapshot(`
    [
      "\\n-# prompt cache miss: 0 of 25k tokens cached, 10m 1s after the last request",
    ]
  `)
  // Less than half of the prompt was written: a partial miss shows nothing.
  expect(cacheLines(withCache({ read: 0, write: 5_000 }, 20_000))).toEqual([])
  expect(effectLines(replay({ events }).effects).filter((line) => line.includes('cache'))).toEqual([])
})

test('compaction posts the new context size from the next root step', () => {
  const events = loadFixture('tools.events.jsonl')
  const sessionID = rootSessionId(events)
  const lastIndex = events.findLastIndex((event) => event.type === 'session.step.ended' && event.data.sessionID === sessionID)
  const compacted: V2Event = {
    id: 'evt_compacted',
    created: 0,
    type: 'session.compaction.ended',
    durable: { aggregateID: sessionID, seq: 0, version: 1 },
    data: { sessionID, reason: 'auto', text: '## Objective', recent: '' },
  }
  const withCompaction = [...events.slice(0, lastIndex), compacted, ...events.slice(lastIndex)]
  expect(effectLines(replay({ events: withCompaction }).effects).filter((line) => line.includes('compacted'))).toMatchInlineSnapshot(`
    [
      "\\n-# context compacted to 26k tokens (6%)",
    ]
  `)
  // `/compact` alone: the execution ends with no step after it.
  const end = events.findLastIndex((event) => event.type === 'session.execution.succeeded')
  const manual = [...events.slice(0, end), compacted, ...events.slice(end)]
  expect(effectLines(replay({ events: manual }).effects).filter((line) => line.includes('compacted'))).toMatchInlineSnapshot(`
    [
      "\\n-# context compacted",
    ]
  `)
})

test('prompts from other clients echo, except the expanded prompt of a command Kimaki ran', () => {
  const events = loadFixture('queue-plain.events.jsonl')
  // Queued ones show in their ack (`[show queue:...]`), a reply to it marks the run.
  const echoes = (before: ThreadEvent[]) =>
    effectLines(replay({ events: [...before, ...events] }).effects).filter((line) => line.includes('» ') || line.startsWith('[reply to'))
  const command = { type: 'kimaki.command' as const, text: '/review auth', username: 'tommy', messageId: null, echo: null }
  expect(echoes([])).toMatchInlineSnapshot(`
    [
      "-# » **user:** Run \`sleep 6 && echo slow-done\` with bash, then say done.",
      "[show queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# » **user:** QUEUED-1: reply with the word apple.
    -# Queued at position 1. Remove it with /clear-queue position:1",
      "[show queue:msg_0f20347e500196F4o0voD7LGMV] -# » **user:** QUEUED-2: reply with the word cherry.
    -# Queued at position 2. Remove it with /clear-queue position:2",
      "[edit queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# » **user:** QUEUED-1: reply with the word apple.",
      "[reply to queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# Queued message sent",
      "[edit queue:msg_0f20347e500196F4o0voD7LGMV] -# » **user:** QUEUED-2: reply with the word cherry.",
      "[reply to queue:msg_0f20347e500196F4o0voD7LGMV] -# Queued message sent",
    ]
  `)
  // The first prompt is the command's template: hidden. The queued ones still show.
  expect(echoes([command])).toMatchInlineSnapshot(`
    [
      "[show queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# » **user:** QUEUED-1: reply with the word apple.
    -# Queued at position 1. Remove it with /clear-queue position:1",
      "[show queue:msg_0f20347e500196F4o0voD7LGMV] -# » **user:** QUEUED-2: reply with the word cherry.
    -# Queued at position 2. Remove it with /clear-queue position:2",
      "[edit queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# » **user:** QUEUED-1: reply with the word apple.",
      "[reply to queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# Queued message sent",
      "[edit queue:msg_0f20347e500196F4o0voD7LGMV] -# » **user:** QUEUED-2: reply with the word cherry.",
      "[reply to queue:msg_0f20347e500196F4o0voD7LGMV] -# Queued message sent",
    ]
  `)
  // A command sent with `kimaki send` has no Discord message: its echo stands in for the template.
  expect(echoes([{ ...command, echo: '-# » **CLI:** /review auth' }])[0]).toMatchInlineSnapshot(`"-# » **CLI:** /review auth"`)
  // A failed command leaves nothing pending.
  expect(echoes([command, { type: 'kimaki.command-failed' }])).toEqual(echoes([]))
})

test('coordinator: a prompt reply goes to its Discord message, a queued one gets "Queued message sent" even when it answers IDLE', () => {
  // The fixture's prompts get Discord metadata, like prompt.ts writes it: messages 101, 102, 103.
  const withDiscord = (threadId: string) => {
    let next = 101
    return loadFixture('queue-plain.events.jsonl').map((event): V2Event => {
      if (event.type !== 'session.inbox.enqueued' || event.data.item.type !== 'user') return event
      const discord = { messageId: String(next++), threadId, username: 'tommy' }
      const item = { ...event.data.item, payload: { ...event.data.item.payload, metadata: { discord } } }
      return { ...event, data: { ...event.data, item } }
    })
  }
  // replay() binds the view to channel `channel`: a prompt whose conversation is that channel is a coordinator prompt.
  expect(effectLines(replay({ events: withDiscord('channel') }).effects)).toMatchInlineSnapshot(`
    [
      "[typing on]",
      "-# *using openai/gpt-6-luna low ⋅ build*",
      "-# ┣ shell _sleep 6 && echo slow-done_",
      "[show queue:msg_0f20347e1001nsJ7W4hOvhBpQb reply to 102] -# Queued at position 1. Delete the original message to remove it, or use /clear-queue position:1",
      "[show queue:msg_0f20347e500196F4o0voD7LGMV reply to 103] -# Queued at position 2. Delete the original message to remove it, or use /clear-queue position:2",
      "[reply to 101] Done.",
      "[silent] -# *main ⋅ 10s ⋅ 6% ⋅ gpt-6-luna*",
      "[edit queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# Queued",
      "[reply to 102] -# Queued message sent",
      "apple",
      "[silent] -# *main ⋅ 2s ⋅ 6% ⋅ gpt-6-luna*",
      "[edit queue:msg_0f20347e500196F4o0voD7LGMV] -# Queued",
      "[reply to 103] -# Queued message sent",
      "cherry",
      "[typing off]",
      "-# *main ⋅ 2s ⋅ 6% ⋅ gpt-6-luna*",
    ]
  `)
  // A coordinator that starts a worker answers IDLE: the queued prompt still shows that it started.
  const idle = withDiscord('channel').map((event) => (event.type === 'session.text.ended' && event.data.text.trim() === 'apple' ? { ...event, data: { ...event.data, text: 'IDLE' } } : event))
  expect(effectLines(replay({ events: idle }).effects).filter((line) => line.includes('queue:msg_0f20347e1001') || line.startsWith('[reply to 102]'))).toMatchInlineSnapshot(`
    [
      "[show queue:msg_0f20347e1001nsJ7W4hOvhBpQb reply to 102] -# Queued at position 1. Delete the original message to remove it, or use /clear-queue position:1",
      "[edit queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# Queued",
      "[reply to 102] -# Queued message sent",
    ]
  `)
  const thread = replay({ events: withDiscord('thread') }).effects
  expect(thread.filter((effect) => effect.type === 'markdown').map((effect) => effect.replyTo)).toEqual([null, null, null])
})

test('snapshot marks an item promoted while disconnected as started, without an echo', () => {
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
      "[edit queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# » **user:** QUEUED-1: reply with the word apple.",
      "[reply to queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# Queued message sent",
    ]
  `)
  expect(hydrated.effects.map((effect) => effect.type)).toEqual(['edit'])
  expect(hydrated.view.inbox[0]?.delivery).toBe('steer')
  expect(reduce({ view: hydrated.view, event: snapshot, prefs: DEFAULT_PREFS }).effects).toEqual([])
})

test('execute: final metadata shows inner calls whose progress was missed, then failures', () => {
  const events = loadFixture('abort.events.jsonl')
  const sessionID = rootSessionId(events)
  const view = emptyView({ sessionId: sessionID, channelId: 'channel', directory: '/project', isNew: false, coordinator: false })
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
      "-#  ⨯  execute.opencode.session\\_move _failed_",
      "-#  ⨯  execute _Error: no such directory_",
    ]
  `)
})
