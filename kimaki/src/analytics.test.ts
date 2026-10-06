// foldAnalytics over recorded OpenCode event streams (spec 29.3): which
// product events one Kimaki thread produces, for the root and its subagents.

import type { V2Event } from '@opencode/client'
import { expect, test } from 'vitest'

import { foldAnalytics, type AnalyticsEvent, type UsageState } from './analytics.ts'
import { eventSessionId } from './thread-reducer.ts'
import { loadFixture, rootSessionId } from './test/replay.ts'

function foldFixture(file: string, { reasoning = 0 }: { reasoning?: number } = {}): AnalyticsEvent[] {
  // The recorded model reports no reasoning; add some to every step to check the total.
  const events = loadFixture(file).map((event): V2Event => {
    if (event.type === 'session.step.ended') return { ...event, data: { ...event.data, tokens: { ...event.data.tokens, reasoning } } }
    if (event.type === 'session.step.failed' && event.data.tokens) return { ...event, data: { ...event.data, tokens: { ...event.data.tokens, reasoning } } }
    return event
  })
  const root = rootSessionId(events)
  const result = events.reduce<{ state: UsageState; events: AnalyticsEvent[] }>(
    (acc, event) => {
      const folded = foldAnalytics({ state: acc.state, event, isRoot: eventSessionId(event) === root })
      return { state: folded.state, events: [...acc.events, ...folded.events] }
    },
    { state: {}, events: [] },
  )
  return result.events
}

test('a turn with a foreground subagent: tokens per execution, one completed turn', () => {
  expect(foldFixture('task-subagent.events.jsonl')).toMatchInlineSnapshot(`
    [
      {
        "name": "turn_started",
        "properties": {},
      },
      {
        "name": "tokens_used",
        "properties": {
          "assistant_message_count": 3,
          "cost": 0,
          "is_subagent": true,
          "model": "gpt-6-luna",
          "provider": "openai",
          "tokens_cache_read": 50176,
          "tokens_cache_write": 0,
          "tokens_input": 35597,
          "tokens_output": 92,
          "tokens_reasoning": 0,
          "tokens_total": 85865,
        },
      },
      {
        "name": "tokens_used",
        "properties": {
          "assistant_message_count": 3,
          "cost": 0,
          "is_subagent": false,
          "model": "gpt-6-luna",
          "provider": "openai",
          "tokens_cache_read": 72192,
          "tokens_cache_write": 0,
          "tokens_input": 3100,
          "tokens_output": 118,
          "tokens_reasoning": 0,
          "tokens_total": 75410,
        },
      },
      {
        "name": "turn_completed",
        "properties": {
          "duration_sec": 13,
        },
      },
    ]
  `)
})

test('an interrupted turn reports the tokens of its failed step but does not complete; reasoning is billed', () => {
  expect(foldFixture('abort.events.jsonl', { reasoning: 100 })).toMatchInlineSnapshot(`
    [
      {
        "name": "turn_started",
        "properties": {},
      },
      {
        "name": "tokens_used",
        "properties": {
          "assistant_message_count": 1,
          "cost": 0,
          "is_subagent": false,
          "model": "gpt-6-luna",
          "provider": "openai",
          "tokens_cache_read": 24064,
          "tokens_cache_write": 0,
          "tokens_input": 836,
          "tokens_output": 22,
          "tokens_reasoning": 100,
          "tokens_total": 25022,
        },
      },
      {
        "name": "turn_started",
        "properties": {},
      },
      {
        "name": "tokens_used",
        "properties": {
          "assistant_message_count": 1,
          "cost": 0,
          "is_subagent": false,
          "model": "gpt-6-luna",
          "provider": "openai",
          "tokens_cache_read": 24064,
          "tokens_cache_write": 0,
          "tokens_input": 897,
          "tokens_output": 8,
          "tokens_reasoning": 100,
          "tokens_total": 25069,
        },
      },
      {
        "name": "turn_completed",
        "properties": {
          "duration_sec": 1,
        },
      },
    ]
  `)
})
