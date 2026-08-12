import { describe, test, expect } from 'vitest'
import { formatPart, formatTodoList, stripToolCallXml, serializeEmbeds, serializePoll, serializeMessageSnapshots } from './message-formatting.js'
import type { Collection, Embed, Message, MessageSnapshot, Poll } from 'discord.js'
import type { Part } from '@opencode-ai/sdk/v2'

describe('stripToolCallXml', () => {
  test('transforms self-closing skill tag into callout', () => {
    expect(stripToolCallXml('<skill name="obsidian-plugin" />')).toBe(
      '<callout accent="#8b5cf6">\nLoaded skill: **obsidian-plugin**\n</callout>',
    )
  })

  test('strips todowrite tags with no content', () => {
    expect(stripToolCallXml('<todowrite>\n<todos>\n</todos>\n</todowrite>')).toBe('')
  })

  test('transforms todowrite with todo items into callout', () => {
    const input = [
      '<todowrite>',
      '<todos>',
      '<todo content="Explore the project structure" status="completed"></todo>',
      '<todo content="Modify author reference" status="in_progress"></todo>',
      '<todo content="Adjust the title" status="pending"></todo>',
      '</todos>',
      '</todowrite>',
    ].join('\n')
    const result = stripToolCallXml(input)
    expect(result).toContain('<callout accent="#3b82f6">')
    expect(result).toContain('✅ explore the project structure')
    expect(result).toContain('⏳ modify author reference')
    expect(result).toContain('☐ adjust the title')
    expect(result).toContain('</callout>')
  })

  test('strips think tags entirely (including content)', () => {
    // Thinking/reasoning blocks are internal and should never be shown
    expect(stripToolCallXml('<think>internal reasoning here</think>')).toBe('')
  })

  test('strips thinking block tags entirely', () => {
    expect(stripToolCallXml('<thinking>let me reason about this</thinking>')).toBe('')
  })

  test('preserves callout tags', () => {
    const text = '<callout accent="#3b82f6">\n## Note\nCheck this out\n</callout>'
    expect(stripToolCallXml(text)).toBe(text)
  })

  test('transforms skill tag mixed with text', () => {
    expect(stripToolCallXml('Here is my answer <skill name="search" /> and more text')).toBe(
      'Here is my answer <callout accent="#8b5cf6">\nLoaded skill: **search**\n</callout> and more text',
    )
  })

  test('strips function_call tags', () => {
    expect(stripToolCallXml('<function_call>do_stuff()</function_call>')).toBe('do_stuff()')
  })

  test('collapses excessive blank lines after stripping', () => {
    const input = 'Hello\n\n\n\n\n<skill name="x" />\n\n\n\nWorld'
    const result = stripToolCallXml(input)
    expect(result).not.toMatch(/\n{3,}/)
  })

  test('returns text unchanged when no XML present', () => {
    expect(stripToolCallXml('Just plain text')).toBe('Just plain text')
  })

  test('handles empty string', () => {
    expect(stripToolCallXml('')).toBe('')
  })

  test('transforms full todowrite block into callout with status icons', () => {
    const input = [
      '<todowrite>',
      '<todos>',
      '<todo content="First task" status="completed"></todo>',
      '<todo content="Second task" status="in_progress"></todo>',
      '<todo content="Third task" status="pending"></todo>',
      '</todos>',
      '</todowrite>',
    ].join('\n')
    const result = stripToolCallXml(input)
    expect(result).toContain('✅ first task')
    expect(result).toContain('⏳ second task')
    expect(result).toContain('☐ third task')
    expect(result).toContain('<callout accent="#3b82f6">')
  })

  test('handles cancelled todo status', () => {
    const input = [
      '<todowrite>',
      '<todos>',
      '<todo content="Abandoned idea" status="cancelled"></todo>',
      '<todo content="Active task" status="in_progress"></todo>',
      '</todos>',
      '</todowrite>',
    ].join('\n')
    const result = stripToolCallXml(input)
    expect(result).toContain('✘ abandoned idea')
    expect(result).toContain('⏳ active task')
  })

  test('strips standalone todo/todo tags not inside todowrite', () => {
    expect(stripToolCallXml('<todos><todo content="task" status="pending"></todo></todos>')).toBe('')
  })

  test('todowrite with only completed items still renders callout', () => {
    const input = [
      '<todowrite>',
      '<todos>',
      '<todo content="All done" status="completed"></todo>',
      '</todos>',
      '</todowrite>',
    ].join('\n')
    const result = stripToolCallXml(input)
    expect(result).toContain('✅ all done')
    expect(result).toContain('<callout accent="#3b82f6">')
  })
})

describe('formatPart', () => {
  test('callout text does not get ⬥ prefix', () => {
    const part: Part = {
      id: 'test',
      type: 'text',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      text: '<callout accent="#ef4444">\n## Top priority\n- **Stripe dispute** deadline\n</callout>',
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

  test('transforms skill XML into callout in text part', () => {
    const part: Part = {
      id: 'test',
      type: 'text',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      text: '<skill name="obsidian-plugin" />',
    }
    const result = formatPart(part)
    expect(result).toContain('<callout accent="#8b5cf6">')
    expect(result).toContain('**obsidian-plugin**')
  })

  test('transforms todowrite XML into callout in text part', () => {
    const part: Part = {
      id: 'test',
      type: 'text',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      text: [
        '<todowrite>',
        '<todos>',
        '<todo content="task" status="pending"></todo>',
        '</todos>',
        '</todowrite>',
      ].join('\n'),
    }
    const result = formatPart(part)
    expect(result).toContain('<callout accent="#3b82f6">')
    expect(result).toContain('☐ task')
  })

  test('preserves callout tags in text part', () => {
    const part: Part = {
      id: 'test',
      type: 'text',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      text: '<callout accent="#3b82f6">\n## Note\nCheck this\n</callout>',
    }
    expect(formatPart(part)).toMatchInlineSnapshot(`
      "
      <callout accent="#3b82f6">
      ## Note
      Check this
      </callout>"
    `)
  })

  test('transforms skill XML inline with text', () => {
    const part: Part = {
      id: 'test',
      type: 'text',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      text: 'Here is my work <skill name="search" /> and more details',
    }
    const result = formatPart(part)
    expect(result).toContain('Loaded skill: **search**')
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
          todos: [
            { content: 'First task', status: 'completed' },
            { content: 'Modify Author Reference', status: 'in_progress' },
          ],
        },
        output: '',
        title: 'todowrite',
        metadata: {},
        time: { start: 0, end: 0 },
      },
    }

    expect(formatTodoList(part)).toMatchInlineSnapshot(`"⒉ **modify Author Reference**"`)
  })

  test('returns empty string when todos is not an array', () => {
    const part: Part = {
      id: 'test',
      type: 'tool',
      tool: 'todowrite',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      callID: 'call_test',
      state: {
        status: 'completed',
        input: { todos: 'not an array' },
        output: '',
        title: 'todowrite',
        metadata: {},
        time: { start: 0, end: 0 },
      },
    }

    expect(formatTodoList(part)).toBe('')
  })

  test('returns empty string when todos is undefined', () => {
    const part: Part = {
      id: 'test',
      type: 'tool',
      tool: 'todowrite',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      callID: 'call_test',
      state: {
        status: 'completed',
        input: {},
        output: '',
        title: 'todowrite',
        metadata: {},
        time: { start: 0, end: 0 },
      },
    }

    expect(formatTodoList(part)).toBe('')
  })

  test('returns empty string when todos is null', () => {
    const part: Part = {
      id: 'test',
      type: 'tool',
      tool: 'todowrite',
      sessionID: 'ses_test',
      messageID: 'msg_test',
      callID: 'call_test',
      state: {
        status: 'completed',
        input: { todos: null },
        output: '',
        title: 'todowrite',
        metadata: {},
        time: { start: 0, end: 0 },
      },
    }

    expect(formatTodoList(part)).toBe('')
  })

  test('returns empty string when todo item content is undefined', () => {
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
          todos: [{ status: 'in_progress' }],
        },
        output: '',
        title: 'todowrite',
        metadata: {},
        time: { start: 0, end: 0 },
      },
    }

    expect(formatTodoList(part)).toBe('')
  })

  test('returns empty string when todo content is empty string', () => {
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
          todos: [{ content: '', status: 'in_progress' }],
        },
        output: '',
        title: 'todowrite',
        metadata: {},
        time: { start: 0, end: 0 },
      },
    }

    expect(formatTodoList(part)).toBe('')
  })
})