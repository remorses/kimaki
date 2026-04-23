import { describe, test, expect } from 'vitest'
import { formatPart, formatTodoList } from './message-formatting.js'
import type { Part } from '@opencode-ai/sdk/v2'

describe('formatPart', () => {
  test('callout text does not get ⬥ prefix', () => {
    const part: Part = {
      id: 'test',
      type: 'text',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      text: `<callout accent="#ef4444">\n## Top priority\n- **Stripe dispute** deadline\n</callout>`,
    }
    expect(formatPart(part)).toMatchInlineSnapshot(`
      "
      <callout accent="#ef4444">
      ## Top priority
      - **Stripe dispute** deadline
      </callout>"
    `)
  })

  test('regular text gets ⬥ prefix', () => {
    const part: Part = {
      id: 'test',
      type: 'text',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      text: 'hello world',
    }
    expect(formatPart(part)).toMatchInlineSnapshot(`"⬥ hello world"`)
  })

  test('text starting with heading does not get ⬥ prefix', () => {
    const part: Part = {
      id: 'test',
      type: 'text',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      text: '## Summary\nDone.',
    }
    expect(formatPart(part)).toMatchInlineSnapshot(`
      "
      ## Summary
      Done."
    `)
  })
})

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
