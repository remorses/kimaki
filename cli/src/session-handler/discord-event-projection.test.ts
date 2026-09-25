import type { V2Event } from '@opencode/client'
import { beforeEach, describe, expect, test } from 'vitest'
import type { VerbosityLevel } from '../schema.js'
import {
  applyDiscordProjectionActions,
  createDiscordProjectionState,
  projectDiscordActions,
  type DiscordProjectionState,
} from './discord-event-projection.js'
import {
  compactSubagentRoutingEvidence,
  type EventBufferEntry,
} from './event-stream-state.js'

let sequence = 0

beforeEach(() => {
  sequence = 0
})

function event<T extends V2Event>(value: Omit<T, 'id' | 'created' | 'durable'>): T {
  return Object.assign(value, {
    id: `evt_${++sequence}`,
    created: sequence * 100,
    durable: { aggregateID: 'ses_main', seq: ++sequence, version: 1 as const },
  }) as T
}

function projectSequence(
  events: V2Event[],
  options: {
    verbosity?: VerbosityLevel
    deliveredPartIds?: ReadonlySet<string>
    largeOutputThresholdTokens?: number
    modelContextLimit?: number
  } = {},
) {
  let state: DiscordProjectionState = createDiscordProjectionState()
  const buffer: EventBufferEntry[] = []
  const deliveredPartIds = new Set(options.deliveredPartIds)
  const actions = events.flatMap((current) => {
    buffer.push({
      event: compactSubagentRoutingEvidence(current) ?? current,
      timestamp: current.type === 'server.connected' ? 0 : current.created,
    })
    const next = projectDiscordActions({
      event: current,
      events: buffer,
      projectedParts: state.parts,
      pendingForms: state.pendingForms,
      shownFormIds: state.shownFormIds,
      mainSessionId: 'ses_main',
      verbosity: options.verbosity ?? 'tools_and_text',
      deliveredPartIds,
      largeOutputThresholdTokens: options.largeOutputThresholdTokens ?? 3_000,
      modelContextLimit: options.modelContextLimit,
    })
    state = applyDiscordProjectionActions({ state, actions: next })
    for (const action of next) {
      if (action.type === 'render-part') deliveredPartIds.add(action.deliveryId)
    }
    return next
  })
  return { state, actions }
}

test('projects concrete output policy for hidden, held, interactive, and large parts', () => {
  const hidden = projectSequence([
    event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
      type: 'session.tool.input.started',
      data: { sessionID: 'ses_main', assistantMessageID: 'msg_hidden', id: 'read_1', name: 'read' },
    }),
    event<Extract<V2Event, { type: 'session.tool.called' }>>({
      type: 'session.tool.called',
      data: {
        sessionID: 'ses_main', assistantMessageID: 'msg_hidden', id: 'read_1',
        input: { filePath: '/tmp/a' }, executed: true,
      },
    }),
  ], { verbosity: 'text_and_essential_tools' })
  expect(hidden.actions.at(-1)).toMatchInlineSnapshot(`
    {
      "destination": "main",
      "partId": "msg_hidden:tool:read_1",
      "reason": "verbosity",
      "type": "skip-part",
    }
  `)
})

test('projects large output, action buttons, held flush, and duplicate replay', () => {
  const largeEvents: V2Event[] = [
    event<Extract<V2Event, { type: 'session.execution.started' }>>({
      type: 'session.execution.started', data: { sessionID: 'ses_main' },
    }),
    event<Extract<V2Event, { type: 'session.step.started' }>>({
      type: 'session.step.started',
      data: {
        sessionID: 'ses_main', assistantMessageID: 'msg_large', agent: 'build',
        model: { providerID: 'openai', id: 'gpt-test' },
      },
    }),
    event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
      type: 'session.tool.input.started',
      data: { sessionID: 'ses_main', assistantMessageID: 'msg_large', id: 'shell_1', name: 'shell' },
    }),
    event<Extract<V2Event, { type: 'session.tool.called' }>>({
      type: 'session.tool.called',
      data: {
        sessionID: 'ses_main', assistantMessageID: 'msg_large', id: 'shell_1',
        input: { command: 'generate', hasSideEffect: true }, executed: true,
      },
    }),
    event<Extract<V2Event, { type: 'session.tool.success' }>>({
      type: 'session.tool.success',
      data: {
        sessionID: 'ses_main', assistantMessageID: 'msg_large', id: 'shell_1',
        content: [{ type: 'text', text: 'x'.repeat(12_000) }], metadata: {}, executed: true,
      },
    }),
  ]
  const large = projectSequence(largeEvents, { modelContextLimit: 100_000 })

  const held = projectSequence([
    event<Extract<V2Event, { type: 'session.text.started' }>>({
      type: 'session.text.started',
      data: { sessionID: 'ses_main', assistantMessageID: 'msg_hold', ordinal: 0 },
    }),
    event<Extract<V2Event, { type: 'session.text.delta' }>>({
      type: 'session.text.delta',
      data: {
        sessionID: 'ses_main', assistantMessageID: 'msg_hold', ordinal: 0, delta: 'Choose now',
      },
    }),
    event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
      type: 'session.tool.input.started',
      data: {
        sessionID: 'ses_main', assistantMessageID: 'msg_hold', id: 'buttons_1',
        name: 'kimaki_action_buttons',
      },
    }),
    event<Extract<V2Event, { type: 'session.tool.called' }>>({
      type: 'session.tool.called',
      data: {
        sessionID: 'ses_main', assistantMessageID: 'msg_hold', id: 'buttons_1',
        input: { buttons: [{ label: 'Yes' }] }, executed: true,
      },
    }),
    event<Extract<V2Event, { type: 'session.tool.success' }>>({
      type: 'session.tool.success',
      data: {
        sessionID: 'ses_main', assistantMessageID: 'msg_hold', id: 'buttons_1',
        content: [{ type: 'text', text: '' }], metadata: {}, executed: true,
      },
    }),
  ])
  const duplicate = projectSequence([
    event<Extract<V2Event, { type: 'session.text.ended' }>>({
      type: 'session.text.ended',
      data: { sessionID: 'ses_main', assistantMessageID: 'msg_dup', ordinal: 0, text: 'Once' },
    }),
  ], { deliveredPartIds: new Set(['msg_dup:text:0']) })

  expect({
    large: large.actions.filter((action) => action.type === 'show-large-output'),
    held: held.actions.filter((action) => {
      return action.type === 'hold-part'
        || action.type === 'render-part'
        || action.type === 'show-action-buttons'
    }),
    duplicate: duplicate.actions.at(-1),
  }).toMatchInlineSnapshot(`
    {
      "duplicate": {
        "destination": "main",
        "partId": "msg_dup:text:0",
        "reason": "delivered",
        "type": "skip-part",
      },
      "held": [
        {
          "destination": "main",
          "partId": "msg_hold:text:0",
          "reason": "open-text",
          "type": "hold-part",
        },
        {
          "content": "Choose now",
          "deliveryId": "msg_hold:text:0",
          "destination": {
            "label": "main",
            "type": "main",
          },
          "kind": "text",
          "leadWithBlankLine": false,
          "partId": "msg_hold:text:0",
          "repulseTyping": true,
          "type": "render-part",
        },
        {
          "partId": "msg_hold:tool:buttons_1",
          "sessionId": "ses_main",
          "type": "show-action-buttons",
        },
      ],
      "large": [
        {
          "content": "shell returned 3.0k tokens (3.0%)",
          "partId": "msg_large:tool:shell_1",
          "type": "show-large-output",
        },
      ],
    }
  `)
})

describe('Discord event projection parts', () => {
  test('folds streaming text and reasoning into stable parts', () => {
    const events: V2Event[] = [
      event<Extract<V2Event, { type: 'session.text.started' }>>({
        type: 'session.text.started',
        data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', ordinal: 0 },
      }),
      event<Extract<V2Event, { type: 'session.text.delta' }>>({
        type: 'session.text.delta',
        data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', ordinal: 0, delta: 'Hello ' },
      }),
      event<Extract<V2Event, { type: 'session.text.delta' }>>({
        type: 'session.text.delta',
        data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', ordinal: 0, delta: 'world' },
      }),
      event<Extract<V2Event, { type: 'session.text.ended' }>>({
        type: 'session.text.ended',
        data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', ordinal: 0, text: 'Hello world' },
      }),
      event<Extract<V2Event, { type: 'session.reasoning.started' }>>({
        type: 'session.reasoning.started',
        data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', ordinal: 1 },
      }),
      event<Extract<V2Event, { type: 'session.reasoning.delta' }>>({
        type: 'session.reasoning.delta',
        data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', ordinal: 1, delta: 'Think' },
      }),
      event<Extract<V2Event, { type: 'session.reasoning.ended' }>>({
        type: 'session.reasoning.ended',
        data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', ordinal: 1, text: 'Thinking' },
      }),
    ]

    expect(projectSequence(events)).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "part": {
              "id": "msg_1:text:0",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "text": "",
              "time": {
                "start": 100,
              },
              "type": "text",
            },
            "type": "store-part",
          },
          {
            "part": {
              "id": "msg_1:text:0",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "text": "Hello ",
              "time": {
                "start": 100,
              },
              "type": "text",
            },
            "type": "store-part",
          },
          {
            "part": {
              "id": "msg_1:text:0",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "text": "Hello world",
              "time": {
                "start": 100,
              },
              "type": "text",
            },
            "type": "store-part",
          },
          {
            "part": {
              "id": "msg_1:text:0",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "text": "Hello world",
              "time": {
                "end": 700,
                "start": 100,
              },
              "type": "text",
            },
            "type": "store-part",
          },
          {
            "content": "> Hello world",
            "deliveryId": "msg_1:text:0",
            "destination": {
              "label": "main",
              "type": "main",
            },
            "kind": "text",
            "leadWithBlankLine": false,
            "partId": "msg_1:text:0",
            "repulseTyping": true,
            "type": "render-part",
          },
          {
            "part": {
              "id": "msg_1:reasoning:1",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "text": "",
              "time": {
                "start": 900,
              },
              "type": "reasoning",
            },
            "type": "store-part",
          },
          {
            "part": {
              "id": "msg_1:reasoning:1",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "text": "Think",
              "time": {
                "start": 900,
              },
              "type": "reasoning",
            },
            "type": "store-part",
          },
          {
            "part": {
              "id": "msg_1:reasoning:1",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "text": "Thinking",
              "time": {
                "end": 1300,
                "start": 900,
              },
              "type": "reasoning",
            },
            "type": "store-part",
          },
          {
            "destination": "main",
            "partId": "msg_1:text:0",
            "reason": "delivered",
            "type": "skip-part",
          },
          {
            "content": "-# ┣ thinking",
            "deliveryId": "msg_1:reasoning:1",
            "destination": {
              "label": "main",
              "type": "main",
            },
            "kind": "tool",
            "leadWithBlankLine": true,
            "partId": "msg_1:reasoning:1",
            "repulseTyping": true,
            "type": "render-part",
          },
        ],
        "state": {
          "parts": [
            {
              "id": "msg_1:text:0",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "text": "Hello world",
              "time": {
                "end": 700,
                "start": 100,
              },
              "type": "text",
            },
            {
              "id": "msg_1:reasoning:1",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "text": "Thinking",
              "time": {
                "end": 1300,
                "start": 900,
              },
              "type": "reasoning",
            },
          ],
          "pendingForms": [],
          "shownFormIds": [],
        },
      }
    `)
  })

  test('folds tool start, completion, and failure with native names and input', () => {
    const events: V2Event[] = [
      event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
        type: 'session.tool.input.started',
        data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', id: 'call_1', name: 'shell' },
      }),
      event<Extract<V2Event, { type: 'session.tool.called' }>>({
        type: 'session.tool.called',
        data: {
          sessionID: 'ses_main', assistantMessageID: 'msg_1', id: 'call_1',
          input: { command: 'echo ok', hasSideEffect: true }, executed: true,
        },
      }),
      event<Extract<V2Event, { type: 'session.tool.success' }>>({
        type: 'session.tool.success',
        data: {
          sessionID: 'ses_main', assistantMessageID: 'msg_1', id: 'call_1',
          content: [{ type: 'text', text: 'ok' }], metadata: { exit: 0 }, executed: true,
        },
      }),
      event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
        type: 'session.tool.input.started',
        data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', id: 'call_2', name: 'read' },
      }),
      event<Extract<V2Event, { type: 'session.tool.called' }>>({
        type: 'session.tool.called',
        data: {
          sessionID: 'ses_main', assistantMessageID: 'msg_1', id: 'call_2',
          input: { filePath: '/tmp/a' }, executed: true,
        },
      }),
      event<Extract<V2Event, { type: 'session.tool.failed' }>>({
        type: 'session.tool.failed',
        data: {
          sessionID: 'ses_main', assistantMessageID: 'msg_1', id: 'call_2',
          error: { type: 'tool', message: 'not found' }, executed: true,
        },
      }),
    ]

    expect(projectSequence(events)).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "part": {
              "id": "msg_1:tool:call_1",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "state": {
                "input": {},
                "raw": "",
                "status": "pending",
              },
              "tool": "shell",
              "type": "tool",
            },
            "type": "store-part",
          },
          {
            "part": {
              "id": "msg_1:tool:call_1",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "state": {
                "input": {
                  "command": "echo ok",
                  "hasSideEffect": true,
                },
                "raw": "",
                "status": "running",
              },
              "tool": "shell",
              "type": "tool",
            },
            "type": "store-part",
          },
          {
            "content": "-# ┣ shell _echo ok_",
            "deliveryId": "msg_1:tool:call_1:running",
            "destination": {
              "label": "main",
              "type": "main",
            },
            "kind": "tool",
            "leadWithBlankLine": false,
            "partId": "msg_1:tool:call_1",
            "repulseTyping": true,
            "type": "render-part",
          },
          {
            "part": {
              "id": "msg_1:tool:call_1",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "state": {
                "input": {
                  "command": "echo ok",
                  "hasSideEffect": true,
                },
                "metadata": {
                  "exit": 0,
                },
                "output": "ok",
                "status": "completed",
                "time": {
                  "end": 500,
                  "start": 500,
                },
              },
              "tool": "shell",
              "type": "tool",
            },
            "type": "store-part",
          },
          {
            "part": {
              "id": "msg_1:tool:call_2",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "state": {
                "input": {},
                "raw": "",
                "status": "pending",
              },
              "tool": "read",
              "type": "tool",
            },
            "type": "store-part",
          },
          {
            "part": {
              "id": "msg_1:tool:call_2",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "state": {
                "input": {
                  "filePath": "/tmp/a",
                },
                "raw": "",
                "status": "running",
              },
              "tool": "read",
              "type": "tool",
            },
            "type": "store-part",
          },
          {
            "destination": "main",
            "partId": "msg_1:tool:call_1",
            "reason": "shown-running",
            "type": "skip-part",
          },
          {
            "content": "-# ┣ read",
            "deliveryId": "msg_1:tool:call_2:running",
            "destination": {
              "label": "main",
              "type": "main",
            },
            "kind": "tool",
            "leadWithBlankLine": false,
            "partId": "msg_1:tool:call_2",
            "repulseTyping": true,
            "type": "render-part",
          },
          {
            "part": {
              "id": "msg_1:tool:call_2",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "state": {
                "error": "not found",
                "input": {
                  "filePath": "/tmp/a",
                },
                "status": "error",
                "time": {
                  "end": 1100,
                  "start": 1100,
                },
              },
              "tool": "read",
              "type": "tool",
            },
            "type": "store-part",
          },
          {
            "content": "-# ⨯ read not found",
            "deliveryId": "msg_1:tool:call_2:error",
            "destination": {
              "label": "main",
              "type": "main",
            },
            "kind": "tool",
            "leadWithBlankLine": false,
            "partId": "msg_1:tool:call_2",
            "repulseTyping": true,
            "type": "render-part",
          },
        ],
        "state": {
          "parts": [
            {
              "id": "msg_1:tool:call_1",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "state": {
                "input": {
                  "command": "echo ok",
                  "hasSideEffect": true,
                },
                "metadata": {
                  "exit": 0,
                },
                "output": "ok",
                "status": "completed",
                "time": {
                  "end": 500,
                  "start": 500,
                },
              },
              "tool": "shell",
              "type": "tool",
            },
            {
              "id": "msg_1:tool:call_2",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "state": {
                "error": "not found",
                "input": {
                  "filePath": "/tmp/a",
                },
                "status": "error",
                "time": {
                  "end": 1100,
                  "start": 1100,
                },
              },
              "tool": "read",
              "type": "tool",
            },
          ],
          "pendingForms": [],
          "shownFormIds": [],
        },
      }
    `)
  })

  test('routes child tools with a stable subagent label', () => {
    const events: V2Event[] = [
      event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
        type: 'session.tool.input.started',
        data: { sessionID: 'ses_main', assistantMessageID: 'msg_parent', id: 'sub_1', name: 'subagent' },
      }),
      event<Extract<V2Event, { type: 'session.tool.called' }>>({
        type: 'session.tool.called',
        data: {
          sessionID: 'ses_main', assistantMessageID: 'msg_parent', id: 'sub_1',
          input: { agent: 'explore', description: 'Inspect code' }, executed: true,
        },
      }),
      event<Extract<V2Event, { type: 'session.tool.success' }>>({
        type: 'session.tool.success',
        data: {
          sessionID: 'ses_main', assistantMessageID: 'msg_parent', id: 'sub_1',
          content: [{ type: 'text', text: 'done' }],
          metadata: { sessionID: 'ses_child', status: 'completed' }, executed: true,
        },
      }),
      event<Extract<V2Event, { type: 'session.step.started' }>>({
        type: 'session.step.started',
        data: {
          sessionID: 'ses_child', assistantMessageID: 'msg_child', agent: 'explore',
          model: { providerID: 'openai', id: 'gpt-test' },
        },
      }),
      event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
        type: 'session.tool.input.started',
        data: { sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'child_call', name: 'shell' },
      }),
      event<Extract<V2Event, { type: 'session.tool.called' }>>({
        type: 'session.tool.called',
        data: {
          sessionID: 'ses_child', assistantMessageID: 'msg_child', id: 'child_call',
          input: { command: 'pwd' }, executed: true,
        },
      }),
    ]

    expect(projectSequence(events).actions.slice(-2)).toMatchInlineSnapshot(`
      [
        {
          "part": {
            "id": "msg_child:tool:child_call",
            "messageID": "msg_child",
            "sessionID": "ses_child",
            "state": {
              "input": {
                "command": "pwd",
              },
              "raw": "",
              "status": "running",
            },
            "tool": "shell",
            "type": "tool",
          },
          "type": "store-part",
        },
        {
          "content": "-# ┣ explore-1 ⋅ shell _pwd_",
          "deliveryId": "msg_child:tool:child_call",
          "destination": {
            "label": "explore-1",
            "type": "subagent",
          },
          "kind": "tool",
          "leadWithBlankLine": false,
          "partId": "msg_child:tool:child_call",
          "repulseTyping": true,
          "type": "render-part",
        },
      ]
    `)
  })
})

describe('Discord event projection terminals and forms', () => {
  function executionEvents(type: 'session.execution.succeeded' | 'session.execution.failed' | 'session.execution.interrupted') {
    const events: V2Event[] = [
      event<Extract<V2Event, { type: 'session.execution.started' }>>({
        type: 'session.execution.started', data: { sessionID: 'ses_main' },
      }),
      event<Extract<V2Event, { type: 'session.step.started' }>>({
        type: 'session.step.started',
        data: {
          sessionID: 'ses_main', assistantMessageID: 'msg_1', agent: 'build',
          model: { providerID: 'openai', id: 'gpt-test' },
        },
      }),
      event<Extract<V2Event, { type: 'session.text.ended' }>>({
        type: 'session.text.ended',
        data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', ordinal: 0, text: 'Finished' },
      }),
      event<Extract<V2Event, { type: 'session.step.ended' }>>({
        type: 'session.step.ended',
        data: {
          sessionID: 'ses_main', assistantMessageID: 'msg_1', finish: 'stop', cost: 0.5,
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
        },
      }),
    ]
    if (type === 'session.execution.failed') {
      events.push(event<Extract<V2Event, { type: 'session.execution.failed' }>>({
        type, data: { sessionID: 'ses_main', error: { type: 'provider', message: 'Provider failed' } },
      }))
    } else if (type === 'session.execution.interrupted') {
      events.push(event<Extract<V2Event, { type: 'session.execution.interrupted' }>>({
        type, data: { sessionID: 'ses_main', reason: 'user' },
      }))
    } else {
      events.push(event<Extract<V2Event, { type: 'session.execution.succeeded' }>>({
        type, data: { sessionID: 'ses_main' },
      }))
    }
    return events
  }

  test('projects successful, failed, and interrupted terminal effects', () => {
    expect({
      succeeded: projectSequence(executionEvents('session.execution.succeeded')).actions.slice(-8),
      failed: projectSequence(executionEvents('session.execution.failed')).actions.slice(-7),
      interrupted: projectSequence(executionEvents('session.execution.interrupted')).actions.slice(-7),
    }).toMatchInlineSnapshot(`
      {
        "failed": [
          {
            "error": "Session failed",
            "sessionId": "ses_main",
            "type": "fail-scheduled-task",
          },
          {
            "analytics": {
              "durationSec": 1,
              "isMainSession": true,
              "isSubagent": false,
              "outcome": "failed",
              "sessionId": "ses_main",
              "usage": {
                "agent": "build",
                "assistantMessageCount": 1,
                "cacheRead": 3,
                "cacheWrite": 1,
                "cost": 0.5,
                "input": 10,
                "model": "gpt-test",
                "output": 5,
                "providerID": "openai",
                "reasoning": 2,
                "startedAt": 1100,
                "total": 21,
              },
            },
            "type": "record-terminal-analytics",
          },
          {
            "type": "stop-typing",
          },
          {
            "destination": "main",
            "partId": "msg_1:text:0",
            "reason": "delivered",
            "type": "skip-part",
          },
          {
            "message": "Provider failed",
            "type": "send-error",
          },
          {
            "type": "reset-run",
          },
          {
            "type": "drain-queue",
          },
        ],
        "interrupted": [
          {
            "sessionId": "ses_main",
            "type": "show-context-usage",
          },
          {
            "part": {
              "id": "msg_1:text:0",
              "messageID": "msg_1",
              "sessionID": "ses_main",
              "text": "Finished",
              "time": {
                "end": 2500,
                "start": 2500,
              },
              "type": "text",
            },
            "type": "store-part",
          },
          {
            "content": "> Finished",
            "deliveryId": "msg_1:text:0",
            "destination": {
              "label": "main",
              "type": "main",
            },
            "kind": "text",
            "leadWithBlankLine": false,
            "partId": "msg_1:text:0",
            "repulseTyping": true,
            "type": "render-part",
          },
          {
            "analytics": {
              "durationSec": 1,
              "isMainSession": true,
              "isSubagent": false,
              "outcome": "interrupted",
              "sessionId": "ses_main",
              "usage": {
                "agent": "build",
                "assistantMessageCount": 1,
                "cacheRead": 3,
                "cacheWrite": 1,
                "cost": 0.5,
                "input": 10,
                "model": "gpt-test",
                "output": 5,
                "providerID": "openai",
                "reasoning": 2,
                "startedAt": 2100,
                "total": 21,
              },
            },
            "type": "record-terminal-analytics",
          },
          {
            "type": "stop-typing",
          },
          {
            "destination": "main",
            "partId": "msg_1:text:0",
            "reason": "delivered",
            "type": "skip-part",
          },
          {
            "type": "reset-run",
          },
        ],
        "succeeded": [
          {
            "sessionId": "ses_main",
            "type": "complete-scheduled-task",
          },
          {
            "analytics": {
              "durationSec": 1,
              "isMainSession": true,
              "isSubagent": false,
              "outcome": "succeeded",
              "sessionId": "ses_main",
              "usage": {
                "agent": "build",
                "assistantMessageCount": 1,
                "cacheRead": 3,
                "cacheWrite": 1,
                "cost": 0.5,
                "input": 10,
                "model": "gpt-test",
                "output": 5,
                "providerID": "openai",
                "reasoning": 2,
                "startedAt": 100,
                "total": 21,
              },
            },
            "type": "record-terminal-analytics",
          },
          {
            "type": "stop-typing",
          },
          {
            "destination": "main",
            "partId": "msg_1:text:0",
            "reason": "delivered",
            "type": "skip-part",
          },
          {
            "content": "Finished",
            "partId": "msg_1:text:0",
            "type": "unquote-final-text",
          },
          {
            "completedAt": 900,
            "startedAt": 100,
            "type": "send-footer",
          },
          {
            "type": "reset-run",
          },
          {
            "type": "drain-queue",
          },
        ],
      }
    `)
  })

  test('projects pending, duplicate, replied, and cancelled forms', () => {
    const form = event<Extract<V2Event, { type: 'form.created' }>>({
      type: 'form.created',
      data: {
        form: {
          id: 'form_1', sessionID: 'ses_main', title: 'Choose',
          metadata: { kind: 'question', tool: { messageID: 'msg_1' } },
          fields: [{
            key: 'choice', type: 'multiselect', title: 'Choice', description: 'Pick one',
            options: [{ label: 'A', value: 'a', description: 'First' }],
          }],
        },
      },
    })
    const replied = event<Extract<V2Event, { type: 'form.replied' }>>({
      type: 'form.replied', data: { sessionID: 'ses_main', id: 'form_1', answer: { choice: ['a'] } },
    })
    const cancelled = event<Extract<V2Event, { type: 'form.cancelled' }>>({
      type: 'form.cancelled', data: { sessionID: 'ses_main', id: 'form_2' },
    })

    expect(projectSequence([form, form, replied, cancelled])).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "form": {
              "formId": "form_1",
              "messageId": "msg_1",
              "questions": [
                {
                  "header": "Choice",
                  "key": "choice",
                  "multiple": true,
                  "options": [
                    {
                      "description": "First",
                      "label": "A",
                      "value": "a",
                    },
                  ],
                  "question": "Pick one",
                },
              ],
              "sessionId": "ses_main",
            },
            "type": "show-form",
          },
          {
            "formId": "form_1",
            "sessionId": "ses_main",
            "type": "settle-form",
          },
          {
            "formId": "form_2",
            "sessionId": "ses_main",
            "type": "settle-form",
          },
        ],
        "state": {
          "parts": [],
          "pendingForms": [],
          "shownFormIds": [
            "form_1",
            "form_2",
          ],
        },
      }
    `)
  })
})

test('live deltas and durable replay converge on the same projected output', () => {
  const started = event<Extract<V2Event, { type: 'session.text.started' }>>({
    type: 'session.text.started',
    data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', ordinal: 0 },
  })
  const delta = event<Extract<V2Event, { type: 'session.text.delta' }>>({
    type: 'session.text.delta',
    data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', ordinal: 0, delta: 'same text' },
  })
  const ended = event<Extract<V2Event, { type: 'session.text.ended' }>>({
    type: 'session.text.ended',
    data: { sessionID: 'ses_main', assistantMessageID: 'msg_1', ordinal: 0, text: 'same text' },
  })
  const live = projectSequence([started, delta, ended])
  const replay = projectSequence([started, ended])

  expect({ live: live.state.parts, replay: replay.state.parts }).toMatchInlineSnapshot(`
    {
      "live": [
        {
          "id": "msg_1:text:0",
          "messageID": "msg_1",
          "sessionID": "ses_main",
          "text": "same text",
          "time": {
            "end": 500,
            "start": 100,
          },
          "type": "text",
        },
      ],
      "replay": [
        {
          "id": "msg_1:text:0",
          "messageID": "msg_1",
          "sessionID": "ses_main",
          "text": "same text",
          "time": {
            "end": 500,
            "start": 100,
          },
          "type": "text",
        },
      ],
    }
  `)
  expect(live.actions.filter((action) => action.type !== 'store-part'))
    .toEqual(replay.actions.filter((action) => action.type !== 'store-part'))
})

test('keeps distinct live labels for parallel children before parent success', () => {
  const events: V2Event[] = [
    event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
      type: 'session.tool.input.started',
      data: { sessionID: 'ses_main', assistantMessageID: 'msg_parent', id: 'sub_1', name: 'subagent' },
    }),
    event<Extract<V2Event, { type: 'session.tool.called' }>>({
      type: 'session.tool.called',
      data: {
        sessionID: 'ses_main', assistantMessageID: 'msg_parent', id: 'sub_1',
        input: { agent: 'explore', description: 'Inspect first' }, executed: true,
      },
    }),
    event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
      type: 'session.tool.input.started',
      data: { sessionID: 'ses_main', assistantMessageID: 'msg_parent', id: 'sub_2', name: 'subagent' },
    }),
    event<Extract<V2Event, { type: 'session.tool.called' }>>({
      type: 'session.tool.called',
      data: {
        sessionID: 'ses_main', assistantMessageID: 'msg_parent', id: 'sub_2',
        input: { agent: 'explore', description: 'Inspect second' }, executed: true,
      },
    }),
    {
      id: 'evt_progress_1',
      created: 1,
      type: 'session.tool.progress',
      data: {
        sessionID: 'ses_main',
        assistantMessageID: 'msg_parent',
        id: 'sub_1',
        metadata: { sessionID: 'ses_child_1', status: 'running' },
      },
    },
    {
      id: 'evt_progress_2',
      created: 2,
      type: 'session.tool.progress',
      data: {
        sessionID: 'ses_main',
        assistantMessageID: 'msg_parent',
        id: 'sub_2',
        metadata: { sessionID: 'ses_child_2', status: 'running' },
      },
    },
    event<Extract<V2Event, { type: 'session.step.started' }>>({
      type: 'session.step.started',
      data: {
        sessionID: 'ses_child_1', assistantMessageID: 'msg_child_1', agent: 'explore',
        model: { providerID: 'openai', id: 'gpt-test' },
      },
    }),
    event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
      type: 'session.tool.input.started',
      data: { sessionID: 'ses_child_1', assistantMessageID: 'msg_child_1', id: 'child_call_1', name: 'shell' },
    }),
    event<Extract<V2Event, { type: 'session.tool.called' }>>({
      type: 'session.tool.called',
      data: {
        sessionID: 'ses_child_1', assistantMessageID: 'msg_child_1', id: 'child_call_1',
        input: { command: 'echo first' }, executed: true,
      },
    }),
    event<Extract<V2Event, { type: 'session.step.started' }>>({
      type: 'session.step.started',
      data: {
        sessionID: 'ses_child_2', assistantMessageID: 'msg_child_2', agent: 'explore',
        model: { providerID: 'openai', id: 'gpt-test' },
      },
    }),
    event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
      type: 'session.tool.input.started',
      data: { sessionID: 'ses_child_2', assistantMessageID: 'msg_child_2', id: 'child_call_2', name: 'shell' },
    }),
    event<Extract<V2Event, { type: 'session.tool.called' }>>({
      type: 'session.tool.called',
      data: {
        sessionID: 'ses_child_2', assistantMessageID: 'msg_child_2', id: 'child_call_2',
        input: { command: 'echo second' }, executed: true,
      },
    }),
  ]

  const labels = projectSequence(events).actions.flatMap((action) => {
    return action.type === 'render-part' && action.destination.type === 'subagent'
      ? [action.destination.label]
      : []
  })
  expect(labels).toEqual(['explore-1', 'explore-2'])
})

test('stores child tools after session.created and routes them once when progress supplies identity', () => {
  const parentStarted = event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
    type: 'session.tool.input.started',
    data: { sessionID: 'ses_main', assistantMessageID: 'msg_parent', id: 'sub_1', name: 'subagent' },
  })
  const parentCalled = event<Extract<V2Event, { type: 'session.tool.called' }>>({
    type: 'session.tool.called',
    data: {
      sessionID: 'ses_main', assistantMessageID: 'msg_parent', id: 'sub_1',
      input: { agent: 'explore', description: 'Inspect first' }, executed: true,
    },
  })
  const childCreated = event<Extract<V2Event, { type: 'session.created' }>>({
    type: 'session.created',
    data: {
      sessionID: 'ses_child_1',
      projectID: 'prj_1',
      location: { directory: '/test' },
      parentID: 'ses_main',
      slug: 'ses_child_1',
      title: 'Inspect first',
      version: '2.0.2',
    },
  })
  const childStep = event<Extract<V2Event, { type: 'session.step.started' }>>({
    type: 'session.step.started',
    data: {
      sessionID: 'ses_child_1', assistantMessageID: 'msg_child_1', agent: 'explore',
      model: { providerID: 'openai', id: 'gpt-test' },
    },
  })
  const childToolStarted = event<Extract<V2Event, { type: 'session.tool.input.started' }>>({
    type: 'session.tool.input.started',
    data: { sessionID: 'ses_child_1', assistantMessageID: 'msg_child_1', id: 'child_call_1', name: 'shell' },
  })
  const childToolCalled = event<Extract<V2Event, { type: 'session.tool.called' }>>({
    type: 'session.tool.called',
    data: {
      sessionID: 'ses_child_1', assistantMessageID: 'msg_child_1', id: 'child_call_1',
      input: { command: 'echo first' }, executed: true,
    },
  })
  const progress: Extract<V2Event, { type: 'session.tool.progress' }> = {
    id: 'evt_progress_early',
    created: 1,
    type: 'session.tool.progress',
    data: {
      sessionID: 'ses_main',
      assistantMessageID: 'msg_parent',
      id: 'sub_1',
      metadata: { sessionID: 'ses_child_1', status: 'running' },
    },
  }

  const before = projectSequence([
    parentStarted,
    parentCalled,
    childCreated,
    childStep,
    childToolStarted,
    childToolCalled,
  ])
  expect(before.actions.filter((action) => {
    return action.type === 'render-part' && action.destination.type === 'subagent'
  })).toEqual([])
  expect(before.state.parts.map((part) => part.id)).toContain('msg_child_1:tool:child_call_1')

  const after = projectSequence([
    parentStarted,
    parentCalled,
    childCreated,
    childStep,
    childToolStarted,
    childToolCalled,
    progress,
  ])
  const routed = after.actions.flatMap((action) => {
    return action.type === 'render-part' && action.destination.type === 'subagent'
      ? [action]
      : []
  })
  expect(routed.map((action) => action.partId)).toEqual(['msg_child_1:tool:child_call_1'])
  expect(routed.map((action) => action.destination.label)).toEqual(['explore-1'])
})
