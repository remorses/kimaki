// Fixtures are the `item/*` frames of the MSP conformance transcripts in
// github.com/meta-models/muse-code-sdk (schema/msp/transcripts, MIT).

import fs from 'node:fs'
import path from 'node:path'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { FoldedItem } from '@muse-code/sdk'
import { expect, test } from 'vitest'
import { createTurnConverter, type Delta } from './items.ts'

type Frame = { method: string; params: { item?: FoldedItem } & Partial<Delta> }

function replay(name: string) {
  const frames = fs
    .readFileSync(path.join(import.meta.dirname, 'fixtures', `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Frame)
  const convert = createTurnConverter()
  const parts = frames.flatMap((frame) => {
    if (frame.method === 'item/delta') return convert.delta({ itemId: frame.params.itemId ?? '', field: frame.params.field, delta: frame.params.delta ?? '' })
    return frame.params.item ? convert.item(frame.params.item) : []
  })
  return [...parts, ...convert.end()]
}

function lines(parts: LanguageModelV3StreamPart[]) {
  return parts.map((part) => {
    if (part.type === 'text-delta' || part.type === 'reasoning-delta') return `${part.type} ${JSON.stringify(part.delta)}`
    if (part.type === 'tool-call') return `tool-call ${part.toolName} ${part.input}`
    if (part.type === 'tool-result') return `tool-result ${part.toolName} ${part.isError ? 'error' : 'ok'} ${JSON.stringify(part.result)}`
    return part.type
  })
}

test('text, tool calls and subagents become stream parts once', () => {
  expect(lines(replay('text-run-single-turn'))).toMatchInlineSnapshot(`
    [
      "text-start",
      "text-delta "All 214 tests pass"",
      "text-delta " except two in tbh-agent..."",
      "text-end",
    ]
  `)
  expect(lines(replay('approval-round-trip'))).toMatchInlineSnapshot(`
    [
      "tool-call write_file {"path":"Cargo.toml"}",
      "tool-result write_file ok "Cargo.toml updated\\n"",
    ]
  `)
  expect(lines(replay('provider-failure-turn'))).toMatchInlineSnapshot(`
    [
      "tool-call read_file {"path":"target/nextest/ci/junit.xml"}",
      "tool-result read_file ok "<testsuite failures=\\"2\\"/>\\n"",
      "text-start",
      "text-delta "Two tests fail in tbh-agent: both in the retry ladder."",
      "text-end",
    ]
  `)
  expect(lines(replay('subagent-nested-lifecycle'))).toMatchInlineSnapshot(`
    [
      "tool-call subagent {"role":"worker","objective":"survey the failing tests"}",
      "tool-call subagent {"role":"worker","objective":"read the two candidate crates"}",
      "tool-result subagent error "could not open the second crate"",
      "tool-result subagent ok "two tbh-agent failures share one fixture"",
    ]
  `)
})

// Shapes recorded from a real muse-spark-1.3 turn: the lead's turn ends while its subagent item is
// still `inProgress` with `controlStatus: resultReady`, and the child's tool calls live in its own session.
test('a subagent with a ready result finishes, shows its tool calls, and open calls get a result', () => {
  const convert = createTurnConverter()
  const subagent = (revision: number, extra: Partial<FoldedItem>): FoldedItem => ({ itemId: 's', kind: 'subagent', turnId: 't', revision, status: 'inProgress', role: 'runner', objective: 'run echo sub-ok', childSessionId: 'c', ...extra })
  const bash = (itemId: string, command: string, output: string): FoldedItem => ({ itemId, kind: 'toolCall', turnId: 'ct', revision: 2, status: 'completed', tool: 'bash', args: JSON.stringify({ command }), visibleOutput: output })
  const parts = [
    ...convert.item(subagent(1, { controlStatus: 'running' })),
    ...convert.children([{ itemId: 'u', kind: 'userMessage', turnId: 'ct', revision: 1, status: 'completed', text: 'Role: runner' }, bash('b1', 'echo sub-ok', 'sub-ok\n'), bash('b2', 'false', '')]),
    ...convert.item(subagent(5, { controlStatus: 'resultReady', result: { summary: 'sub-ok', text: 'sub-ok', evidenceRefs: [], artifactRefs: [] } })),
    ...convert.item(subagent(6, { controlStatus: 'closed', status: 'completed', result: { summary: 'sub-ok', text: 'sub-ok', evidenceRefs: [], artifactRefs: [] } })),
    ...convert.item({ itemId: 'w', kind: 'toolCall', turnId: 't', revision: 1, status: 'inProgress', tool: 'monitor', args: '{}' }),
    ...convert.end(),
  ]
  expect(lines(parts)).toMatchInlineSnapshot(`
    [
      "tool-call subagent {"role":"runner","objective":"run echo sub-ok"}",
      "tool-call subagent.bash {"command":"echo sub-ok"}",
      "tool-result subagent.bash ok "sub-ok\\n"",
      "tool-call subagent.bash {"command":"false"}",
      "tool-result subagent.bash ok "completed"",
      "tool-result subagent ok "sub-ok"",
      "tool-call monitor {}",
      "tool-result monitor ok "Still running in Muse when the turn ended."",
    ]
  `)
})

// Items and deltas come from two streams, so an older item revision can land after newer deltas.
test('out of order revisions and deltas never repeat or lose text', () => {
  const convert = createTurnConverter()
  const message = ({ revision, status, text }: { revision: number; status: string; text: string }): FoldedItem => ({ itemId: 'm', kind: 'agentMessage', turnId: 't', revision, status, text })
  const parts = [
    ...convert.delta({ itemId: 'm', delta: 'Hello' }),
    ...convert.item(message({ revision: 1, status: 'inProgress', text: '' })),
    ...convert.delta({ itemId: 'm', delta: ' world' }),
    ...convert.item(message({ revision: 2, status: 'inProgress', text: 'Hello' })),
    ...convert.item(message({ revision: 3, status: 'completed', text: 'Hello world, done.' })),
    ...convert.delta({ itemId: 'm', delta: ' late' }),
    // Snapshot first, then deltas that repeat it.
    ...convert.item({ ...message({ revision: 1, status: 'inProgress', text: 'Hi' }), itemId: 'n' }),
    ...convert.delta({ itemId: 'n', delta: 'Hi' }),
    ...convert.delta({ itemId: 'n', delta: ' there' }),
    ...convert.item({ ...message({ revision: 2, status: 'completed', text: 'Hi there' }), itemId: 'n' }),
    ...convert.delta({ itemId: 'r', field: 'summary.0', delta: 'plan' }),
    ...convert.delta({ itemId: 'r', field: 'summary.1', delta: 'check' }),
    ...convert.end(),
  ]
  expect(lines(parts)).toMatchInlineSnapshot(`
    [
      "text-start",
      "text-delta "Hello"",
      "text-delta " world"",
      "text-delta ", done."",
      "text-end",
      "text-start",
      "text-delta "Hi"",
      "text-delta " there"",
      "text-end",
      "reasoning-start",
      "reasoning-delta "plan"",
      "reasoning-delta "\\n\\ncheck"",
      "reasoning-end",
    ]
  `)
})
