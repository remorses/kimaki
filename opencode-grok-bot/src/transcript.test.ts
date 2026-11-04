import { expect, test } from 'vitest'
import { cardAnswer, createActivityTracker, createTurnConverter, type Activity, type Entry } from './transcript.ts'

test('renders the transcript entries of one turn as parts, across repeated polls', () => {
  const convert = createTurnConverter()
  // Shapes from real getAgentTranscriptTail responses and transcript events; each inner array is one poll.
  const polls: Entry[][] = [
    [{ kind: 'message', id: 't0u', role: 'user', content: 'Run `echo hi-42`', clientNonce: 'n1', requestId: 'r1' }],
    [
      { kind: 'message', id: 't0u', role: 'user', content: 'Run `echo hi-42`', clientNonce: 'n1', requestId: 'r1' },
      { kind: 'send-message', id: 't0s0', message: { type: 'text', content: 'Running it now.' }, requestId: 'r1' },
    ],
    [
      { kind: 'send-message', id: 't0s0', message: { type: 'text', content: 'Running it now.' }, requestId: 'r1' },
      { kind: 'message', id: 't0m1', role: 'assistant', content: 'Streaming', isStreaming: true },
    ],
    [
      { kind: 'message', id: 't0m1', role: 'assistant', content: 'Streaming answer' },
      { kind: 'send-message', id: 't0s2', message: { type: 'attachment', file_name: 'leads.csv', url: 'file:///home/box/leads.csv' }, requestId: 'r1' },
      { kind: 'send-message', id: 't0s3', message: { type: 'connector', connector: 'Inkbox' } as Entry['message'], requestId: 'r1' },
      {
        kind: 'send-message',
        id: 't0s4',
        message: { type: 'widget', widget: { prompt: 'Add a second X account?', options: [{ label: 'Yes', value: 'Yes, add it' }, { label: 'Not now' }] } },
        requestId: 'r1',
      },
      { kind: 'notice', id: 'n1', text: 'A background task was stopped after 50 minutes so it would not hang.' },
    ],
  ]
  const parts = [...polls.flatMap((entries) => entries.flatMap(convert.push)), ...convert.end()]
  expect(parts).toMatchInlineSnapshot(`
    [
      {
        "id": "t0s0",
        "type": "text-start",
      },
      {
        "delta": "Running it now.",
        "id": "t0s0",
        "type": "text-delta",
      },
      {
        "id": "t0s0",
        "type": "text-end",
      },
      {
        "id": "t0m1",
        "type": "text-start",
      },
      {
        "delta": "Streaming",
        "id": "t0m1",
        "type": "text-delta",
      },
      {
        "delta": " answer",
        "id": "t0m1",
        "type": "text-delta",
      },
      {
        "id": "t0m1",
        "type": "text-end",
      },
      {
        "id": "t0s2",
        "type": "text-start",
      },
      {
        "delta": "**File:** leads.csv",
        "id": "t0s2",
        "type": "text-delta",
      },
      {
        "id": "t0s2",
        "type": "text-end",
      },
      {
        "id": "t0s3",
        "type": "text-start",
      },
      {
        "delta": "**Connect app:** Inkbox. Connect it in the Grok Bot app.",
        "id": "t0s3",
        "type": "text-delta",
      },
      {
        "id": "t0s3",
        "type": "text-end",
      },
      {
        "id": "t0s4",
        "type": "text-start",
      },
      {
        "delta": "**Question:** Add a second X account?

    1. Yes
    2. Not now

    Reply with an option number.",
        "id": "t0s4",
        "type": "text-delta",
      },
      {
        "id": "t0s4",
        "type": "text-end",
      },
      {
        "id": "n1",
        "type": "text-start",
      },
      {
        "delta": "*A background task was stopped after 50 minutes so it would not hang.*",
        "id": "n1",
        "type": "text-delta",
      },
      {
        "id": "n1",
        "type": "text-end",
      },
    ]
  `)
})

test('bot activity becomes one tool call per distinct tool', () => {
  const activity = createActivityTracker({ prefix: 'activity' })
  // currentActivity values from real agent-upserted events, repeated as the roster updates.
  const updates: Activity[] = [
    null,
    { kind: 'thinking' },
    { kind: 'tool', tool: 'SetStatus', detail: 'is running shell commands' },
    { kind: 'tool', tool: 'SetStatus', detail: 'is running shell commands' },
    { kind: 'tool', tool: 'Screenshot' },
    { kind: 'thinking' },
    null,
  ]
  expect([...updates.flatMap(activity.update), ...activity.end()]).toMatchInlineSnapshot(`
    [
      {
        "input": "{"detail":"is running shell commands"}",
        "providerExecuted": true,
        "toolCallId": "activity-1",
        "toolName": "activity",
        "type": "tool-call",
      },
      {
        "result": "done",
        "toolCallId": "activity-1",
        "toolName": "activity",
        "type": "tool-result",
      },
      {
        "input": "{}",
        "providerExecuted": true,
        "toolCallId": "activity-2",
        "toolName": "Screenshot",
        "type": "tool-call",
      },
      {
        "result": "done",
        "toolCallId": "activity-2",
        "toolName": "Screenshot",
        "type": "tool-result",
      },
    ]
  `)
})

test('a reply to a pending card answers it only when it is a valid answer', () => {
  const widget: Entry = {
    id: 'w1',
    kind: 'send-message',
    message: { type: 'widget', widget: { prompt: 'Pick', multiSelect: true, options: [{ label: 'One' }, { label: 'Two', value: 'two' }] } },
  }
  const approval: Entry = { id: 'a1', kind: 'send-message', message: { type: 'auto-review-approval', approval: { status: 'pending', requestId: 'r1' } } }
  expect({
    numbers: cardAnswer({ entry: widget, agentId: 'bot', reply: '1, 2' }),
    label: cardAnswer({ entry: widget, agentId: 'bot', reply: 'two' }),
    other: cardAnswer({ entry: widget, agentId: 'bot', reply: 'actually do something else' }),
    approve: cardAnswer({ entry: approval, agentId: 'bot', reply: 'Approve.' }),
    unrelated: cardAnswer({ entry: approval, agentId: 'bot', reply: 'what does it do?' }),
  }).toMatchInlineSnapshot(`
    {
      "approve": {
        "body": {
          "agentId": "bot",
          "approvalPlatform": "desktop",
          "entryId": "a1",
          "requestId": "r1",
          "resolution": "approved",
        },
        "method": "resolveAutoReviewApproval",
      },
      "label": {
        "body": {
          "agentId": "bot",
          "entryId": "w1",
          "value": "two",
        },
        "method": "respondToWidget",
      },
      "numbers": {
        "body": {
          "agentId": "bot",
          "entryId": "w1",
          "value": "One
    two",
        },
        "method": "respondToWidget",
      },
      "other": null,
      "unrelated": null,
    }
  `)
})
