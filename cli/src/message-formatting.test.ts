import { describe, test, expect } from 'vitest'
import {
  collectFullSessionChunks,
  formatTodoList,
} from './message-formatting.js'
import type { Part } from '@opencode-ai/sdk/v2'

describe('formatTodoList', () => {
  test('formats active todo with monospace numbers', () => {
    const part: Part = {
      id: 'test',
      type: 'tool',
      tool: 'todowrite',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      callID: 'call_test',
      state: {
        status: 'completed',
        input: {
          todos: [
            { content: 'First task', status: 'completed' },
            { content: 'Second task', status: 'in_progress' },
            { content: 'Third task', status: 'pending' },
          ],
        },
        output: '',
        title: 'todowrite',
        metadata: {},
        time: { start: 0, end: 0 },
      },
    }

    expect(formatTodoList(part)).toMatchInlineSnapshot(`"⒉ **second task**"`)
  })

  test('formats double digit todo numbers', () => {
    const todos = Array.from({ length: 12 }, (_, i) => ({
      content: `Task ${i + 1}`,
      status: i === 11 ? 'in_progress' : 'completed',
    }))

    const part: Part = {
      id: 'test',
      type: 'tool',
      tool: 'todowrite',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      callID: 'call_test',
      state: {
        status: 'completed',
        input: { todos },
        output: '',
        title: 'todowrite',
        metadata: {},
        time: { start: 0, end: 0 },
      },
    }

    expect(formatTodoList(part)).toMatchInlineSnapshot(`"⒓ **task 12**"`)
  })

  test('lowercases first letter of content', () => {
    const part: Part = {
      id: 'test',
      type: 'tool',
      tool: 'todowrite',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      callID: 'call_test',
      state: {
        status: 'completed',
        input: {
          todos: [{ content: 'Fix the bug', status: 'in_progress' }],
        },
        output: '',
        title: 'todowrite',
        metadata: {},
        time: { start: 0, end: 0 },
      },
    }

    expect(formatTodoList(part)).toMatchInlineSnapshot(`"⒈ **fix the bug**"`)
  })
})

describe('collectFullSessionChunks', () => {
  test('includes user prompts and assistant history in order', () => {
    const messages: Parameters<typeof collectFullSessionChunks>[0]['messages'] = [
      {
        info: { role: 'user', id: 'msg-user-1' },
        parts: [
          {
            id: 'part-user-synthetic',
            type: 'text',
            text: 'system reminder',
            synthetic: true,
            sessionID: 'ses_test',
            messageID: 'msg-user-1',
          },
          {
            id: 'part-user-1',
            type: 'text',
            text: 'Inspect the subagent session',
            sessionID: 'ses_test',
            messageID: 'msg-user-1',
          },
        ],
      },
      {
        info: { role: 'assistant', id: 'msg-assistant-1' },
        parts: [
          {
            id: 'part-assistant-1',
            type: 'text',
            text: 'Here is what happened.',
            sessionID: 'ses_test',
            messageID: 'msg-assistant-1',
          },
          {
            id: 'part-assistant-tool',
            type: 'tool',
            tool: 'bash',
            sessionID: 'ses_test',
            messageID: 'msg-assistant-1',
            callID: 'call-1',
            state: {
              status: 'completed',
              input: {
                command: 'git status',
                description: 'Show repo status',
              },
              output: '',
              title: 'bash',
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ],
      },
    ]

    expect(collectFullSessionChunks({ messages })).toMatchInlineSnapshot(`
      [
        {
          "content": "**User**

      Inspect the subagent session",
          "partIds": [],
        },
        {
          "content": "**Assistant**

      ⬥ Here is what happened.

      ┣ bash _git status_",
          "partIds": [
            "part-assistant-1",
            "part-assistant-tool",
          ],
        },
      ]
    `)
  })
})
