import { expect, test } from 'vitest'
import { downloadPath } from './grok-bot.ts'
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

test('files the bot sends show the local path they are saved to', () => {
  process.env.GROK_BOT_DOWNLOAD_DIR = '/downloads'
  const asked: string[] = []
  const convert = createTurnConverter({
    saved: (file) => {
      asked.push(file.url)
      return downloadPath(file)
    },
  })
  const asset = 'file:///home/box/agent-data/agents/25730021-d14b-4280-8e7f-3a2fcc03ae8b/assets/9a39182b57f959d9d6923d2cfe9308a0fbc2400c782f16d2ad77eff325303a3d.csv'
  const image = 'file:///home/box/sand-data/agents/25730021-d14b-4280-8e7f-3a2fcc03ae8b/images/0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0.png'
  // Shapes from a real transcript; the name comes from the bot, so path parts are dropped.
  const entries: Entry[] = [
    { kind: 'send-message', id: 's1', message: { type: 'attachment', url: asset, file_name: '../exports/morse_followers.csv', source_path: '/workspace/morse_followers.csv' } },
    { kind: 'send-message', id: 's2', message: { type: 'text', content: 'Here is the chart.', images: [{ url: image, alt: 'Follower chart' }, { url: 'https://example.com/a.png' }] } },
    { kind: 'send-message', id: 's3', message: { type: 'attachment', url: 'file:///workspace/notes.txt', file_name: 'notes.txt' } },
  ]
  const text = [...entries.flatMap(convert.push), ...convert.end()].flatMap((part) => (part.type === 'text-delta' ? [part.delta] : []))
  expect({ text, asked }).toMatchInlineSnapshot(`
    {
      "asked": [
        "file:///home/box/agent-data/agents/25730021-d14b-4280-8e7f-3a2fcc03ae8b/assets/9a39182b57f959d9d6923d2cfe9308a0fbc2400c782f16d2ad77eff325303a3d.csv",
        "file:///home/box/sand-data/agents/25730021-d14b-4280-8e7f-3a2fcc03ae8b/images/0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0.png",
        "https://example.com/a.png",
        "file:///workspace/notes.txt",
      ],
      "text": [
        "**File:** saved to \`/downloads/9a39182b/morse_followers.csv\`",
        "Here is the chart.
    **Image:** saved to \`/downloads/0f1e2d3c/0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0.png\`
    ![image](https://example.com/a.png)",
        "**File:** notes.txt",
      ],
    }
  `)
})

test('bot activity becomes one tool call per distinct tool', () => {
  const activity = createActivityTracker({ prefix: 'activity' })
  // Live activity values from real turns, repeated across polls.
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
          "requestId": "r1",
          "resolution": "GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_APPROVED",
        },
        "method": "ResolveGrokBotAutoReviewApproval",
      },
      "label": {
        "body": {
          "agentId": "bot",
          "entryId": "w1",
          "value": "two",
        },
        "method": "RespondGrokBotWidget",
      },
      "numbers": {
        "body": {
          "agentId": "bot",
          "entryId": "w1",
          "value": "One
    two",
        },
        "method": "RespondGrokBotWidget",
      },
      "other": null,
      "unrelated": null,
    }
  `)
})
