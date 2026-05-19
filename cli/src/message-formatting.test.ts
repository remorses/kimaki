import { describe, test, expect } from 'vitest'
import { formatPart, formatTodoList, serializeEmbeds } from './message-formatting.js'
import type { Embed } from 'discord.js'
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

describe('serializeEmbeds', () => {
  function fakeEmbed(data: {
    title?: string
    description?: string
    url?: string
    author?: { name: string }
    footer?: { text: string }
    fields?: Array<{ name: string; value: string; inline?: boolean }>
  }): Embed {
    return {
      title: data.title ?? null,
      description: data.description ?? null,
      url: data.url ?? null,
      author: data.author ?? null,
      footer: data.footer ?? null,
      fields: data.fields ?? [],
    } as unknown as Embed
  }

  test('serializes a full embed with all fields', () => {
    const embeds = [
      fakeEmbed({
        author: { name: 'GitHub' },
        title: 'PR #42: Fix auth timeout',
        url: 'https://github.com/org/repo/pull/42',
        description: 'Fixes the retry logic so tokens refresh before expiry.',
        fields: [
          { name: 'Status', value: 'Open' },
          { name: 'Reviewers', value: 'alice, bob' },
        ],
        footer: { text: 'Last updated 2h ago' },
      }),
    ]
    expect(serializeEmbeds(embeds)).toMatchInlineSnapshot(`
      "<embed>
      Author: GitHub
      Title: PR #42: Fix auth timeout
      URL: https://github.com/org/repo/pull/42
      Fixes the retry logic so tokens refresh before expiry.
      Status: Open
      Reviewers: alice, bob
      Footer: Last updated 2h ago
      </embed>"
    `)
  })

  test('serializes description-only embed (link preview)', () => {
    const embeds = [
      fakeEmbed({
        title: 'Example Site',
        url: 'https://example.com',
        description: 'An example website for testing.',
      }),
    ]
    expect(serializeEmbeds(embeds)).toMatchInlineSnapshot(`
      "<embed>
      Title: Example Site
      URL: https://example.com
      An example website for testing.
      </embed>"
    `)
  })

  test('returns empty string for no embeds', () => {
    expect(serializeEmbeds([])).toBe('')
  })

  test('skips embeds with no text content', () => {
    // An embed with only an image and no text fields
    const embeds = [fakeEmbed({})]
    expect(serializeEmbeds(embeds)).toBe('')
  })

  test('serializes multiple embeds', () => {
    const embeds = [
      fakeEmbed({ title: 'First', description: 'one' }),
      fakeEmbed({ title: 'Second', description: 'two' }),
    ]
    expect(serializeEmbeds(embeds)).toMatchInlineSnapshot(`
      "<embed>
      Title: First
      one
      </embed>

      <embed>
      Title: Second
      two
      </embed>"
    `)
  })
})
