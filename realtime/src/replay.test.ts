// Replays recorded provider wire logs (fixtures/*.wire.jsonl, from live.e2e.test.ts)
// through the adapters and the reducer. Fast, offline, real provider messages.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { expect, test } from 'vitest'
import { gemini } from './gemini.ts'
import { openai, xai } from './openai.ts'
import { encodeWav, readWav } from './audio.ts'
import { deriveHistory, deriveMessages, deriveView } from './reducer.ts'
import type { Adapter, RealtimeEvent } from './types.ts'

const fixtures = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../fixtures')

function replay({ file, model }: { file: string; model: Adapter }): RealtimeEvent[] {
  return fs
    .readFileSync(path.join(fixtures, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: 'in' | 'out'; data: unknown })
    .filter((line) => line.direction === 'in')
    .flatMap((line) => model.decode(line.data))
    .filter((event): event is RealtimeEvent => event.type !== 'output.audio')
}

function summary(events: RealtimeEvent[]) {
  const view = deriveView(events)
  return {
    messages: view.messages.map((m) => (m.kind === 'tool' ? `tool ${m.name} ${m.args}` : `${m.kind}: ${m.text}`)),
    history: deriveHistory(events).map((item) => item.role),
    responding: view.responding,
    pendingToolCalls: view.pendingToolCalls,
    hasResumeHandle: view.resumeHandle !== null,
    outputTokens: view.usage.outputTokens > 0,
  }
}

test('openai spoken question', () => {
  const events = replay({ file: 'openai-question.wire.jsonl', model: openai({ apiKey: '' }) })
  expect(summary(events)).toMatchInlineSnapshot(`
    {
      "hasResumeHandle": false,
      "history": [
        "user",
        "assistant",
      ],
      "messages": [
        "user: Hi there, in one short sentence, what is the capital of France?",
        "assistant: The capital of France is Paris.",
      ],
      "outputTokens": true,
      "pendingToolCalls": [],
      "responding": false,
    }
  `)
})

test('openai tool call: server events alone need a tool result before the next response', () => {
  const events = replay({ file: 'openai-tool.wire.jsonl', model: openai({ apiKey: '' }) })
  expect(summary(events)).toMatchInlineSnapshot(`
    {
      "hasResumeHandle": false,
      "history": [
        "user",
        "assistant",
        "assistant",
      ],
      "messages": [
        "user: Please use your weather tool to check the weather in Rome, then tell me the result.",
        "assistant: Checking the latest weather for Rome now.",
        "tool get_weather {"city":"Rome"}",
        "assistant: Rome is 21 degrees Celsius and sunny.",
      ],
      "outputTokens": true,
      "pendingToolCalls": [
        "call_CGcnzkmaIwf7Wiut",
      ],
      "responding": false,
    }
  `)
  const call = events.find((e) => e.type === 'tool.call')
  if (call?.type !== 'tool.call') throw new Error('no tool call in fixture')
  const firstDone = events.findIndex((e) => e.type === 'response.done')
  const beforeResult = events.slice(0, firstDone + 1)
  expect(deriveView(beforeResult).needsResponse).toBe(false)
  const withResult: RealtimeEvent[] = [
    ...beforeResult,
    { type: 'tool.result', callId: call.callId, name: call.name, output: '{}' },
  ]
  expect(deriveView(withResult).needsResponse).toBe(true)
  expect(deriveView([...withResult, { type: 'response.requested' }]).needsResponse).toBe(false)
})

test('tool loop: parallel calls wait for every output, cancelled replies never continue', () => {
  const calls: RealtimeEvent[] = [
    { type: 'response.started', responseId: 'r1' },
    { type: 'tool.call', callId: 'a', name: 'x', args: '{}' },
    { type: 'tool.call', callId: 'b', name: 'x', args: '{}' },
  ]
  const result = (callId: string): RealtimeEvent => ({ type: 'tool.result', callId, name: 'x', output: '{}' })
  const done = (status: 'completed' | 'cancelled'): RealtimeEvent => ({ type: 'response.done', status })
  expect(deriveView([...calls, result('a'), done('completed')]).needsResponse).toBe(false)
  expect(deriveView([...calls, result('a'), done('completed'), result('b')]).needsResponse).toBe(true)
  expect(deriveView([...calls, done('cancelled'), result('a'), result('b')]).needsResponse).toBe(false)
})

test('gemini transcripts that interleave join the open message of their role', () => {
  const events: RealtimeEvent[] = [
    { type: 'speech.started' },
    { type: 'input.text', text: 'Hello', itemId: null, final: false },
    { type: 'output.text', text: 'Hi', itemId: null },
    { type: 'input.text', text: ' there', itemId: null, final: false },
    { type: 'output.text', text: ' you', itemId: null },
    { type: 'response.done', status: 'completed' },
    { type: 'speech.started' },
    { type: 'input.text', text: 'Bye', itemId: null, final: false },
  ]
  expect(deriveMessages(events).map((m) => (m.kind === 'tool' ? m.name : `${m.kind}: ${m.text}`))).toMatchInlineSnapshot(`
    [
      "user: Hello there",
      "assistant: Hi you",
      "user: Bye",
    ]
  `)
})

test('replies never continue across connections, truncated replies leave history', () => {
  const events: RealtimeEvent[] = [
    { type: 'output.text', text: 'Old partial.', itemId: null },
    { type: 'session.closed', code: 1006, reason: '' },
    { type: 'session.started', provider: 'gemini', model: 'gemini-3.8-live', sessionId: null },
    { type: 'user.text', text: 'New question' },
    { type: 'output.text', text: 'New answer.', itemId: null },
    { type: 'response.done', status: 'completed' },
    { type: 'output.text', text: 'Long reply the user cut off', itemId: 'item_1' },
    { type: 'output.truncated', itemId: 'item_1', text: null },
    { type: 'output.text', text: 'Another reply nobody heard fully', itemId: 'item_2' },
    { type: 'output.truncated', itemId: 'item_2', text: 'Another reply' },
  ]
  expect(deriveMessages(events).map((m) => (m.kind === 'tool' ? m.name : `${m.kind}: ${m.text}`))).toMatchInlineSnapshot(`
    [
      "assistant: Old partial.",
      "user: New question",
      "assistant: New answer.",
      "assistant: Long reply the user cut off",
      "assistant: Another reply",
    ]
  `)
  expect(deriveHistory(events)).toMatchInlineSnapshot(`
    [
      {
        "role": "assistant",
        "text": "Old partial.",
      },
      {
        "role": "user",
        "text": "New question",
      },
      {
        "role": "assistant",
        "text": "New answer.",
      },
      {
        "role": "assistant",
        "text": "Another reply",
      },
    ]
  `)
})

test('readWav reads only the data chunk of a pooled Buffer', () => {
  const wav = readWav(Buffer.from(encodeWav({ pcm: Int16Array.from([100, -200, 300]), rate: 24000 })))
  if (wav instanceof Error) throw wav
  expect(Array.from(wav.pcm)).toEqual([100, -200, 300])
})

test('xai spoken question: usage comes from the top-level usage field', () => {
  const events = replay({ file: 'xai-question.wire.jsonl', model: xai({ apiKey: '' }) })
  expect(summary(events)).toMatchInlineSnapshot(`
    {
      "hasResumeHandle": true,
      "history": [
        "user",
        "assistant",
      ],
      "messages": [
        "user: Hi there, in one short sentence, what is the capital of France?",
        "assistant: The capital of France is Paris.",
      ],
      "outputTokens": true,
      "pendingToolCalls": [],
      "responding": false,
    }
  `)
  expect(deriveView(events).usage.billedSeconds).toBeGreaterThan(0)
})

test('xai tool call', () => {
  const events = replay({ file: 'xai-tool.wire.jsonl', model: xai({ apiKey: '' }) })
  expect(summary(events)).toMatchInlineSnapshot(`
    {
      "hasResumeHandle": true,
      "history": [
        "user",
        "assistant",
        "assistant",
      ],
      "messages": [
        "user: Please use your weather tool to check the weather in Rome, then tell me the result.",
        "assistant: I'll check the weather in Rome for you.",
        "tool get_weather {"city":"Rome"}",
        "assistant: The weather in Rome is sunny with a temperature of 21°C.",
      ],
      "outputTokens": true,
      "pendingToolCalls": [
        "call-1b956d85-7053-41bb-a84f-4f40bd70123e-0",
      ],
      "responding": false,
    }
  `)
})

test('gemini spoken question', () => {
  const events = replay({ file: 'gemini-question.wire.jsonl', model: gemini({ apiKey: '' }) })
  expect(summary(events)).toMatchInlineSnapshot(`
    {
      "hasResumeHandle": true,
      "history": [
        "user",
        "assistant",
      ],
      "messages": [
        "user: In one short sentence, what is the capital of France?",
        "assistant: The capital of France is Paris.",
      ],
      "outputTokens": true,
      "pendingToolCalls": [],
      "responding": false,
    }
  `)
})

test('gemini tool call', () => {
  const events = replay({ file: 'gemini-tool.wire.jsonl', model: gemini({ apiKey: '' }) })
  expect(summary(events)).toMatchInlineSnapshot(`
    {
      "hasResumeHandle": true,
      "history": [
        "user",
        "assistant",
      ],
      "messages": [
        "user: Please use your weather tool to check the weather in Rome, then tell me the result.",
        "tool get_weather {"city":"Rome"}",
        "assistant: The weather in Rome is sunny with a temperature of 21 degrees Celsius.",
      ],
      "outputTokens": true,
      "pendingToolCalls": [
        "call_681447",
      ],
      "responding": false,
    }
  `)
})
