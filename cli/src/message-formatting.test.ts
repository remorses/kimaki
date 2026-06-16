import { describe, test, expect } from 'vitest'
import { formatPart, formatTodoList, serializeEmbeds, serializePoll, serializeMessageSnapshots } from './message-formatting.js'
import type { Collection, Embed, Message, MessageSnapshot, Poll } from 'discord.js'
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

// Helper to create a fake Map-like Collection for tests
function fakeCollection<K, V>(entries: [K, V][]): Collection<K, V> {
  const map = new Map(entries)
  return {
    size: map.size,
    [Symbol.iterator]: map[Symbol.iterator].bind(map),
  } as unknown as Collection<K, V>
}

describe('serializePoll', () => {
  function fakePoll(data: {
    question: string
    answers: Array<{ id: number; text: string | null }>
  }): Poll {
    return {
      question: { text: data.question },
      answers: fakeCollection(
        data.answers.map((a) => [a.id, { text: a.text }]),
      ),
    } as unknown as Poll
  }

  test('serializes a poll with question and answers', () => {
    const poll = fakePoll({
      question: 'Which framework?',
      answers: [
        { id: 1, text: 'React' },
        { id: 2, text: 'Vue' },
        { id: 3, text: 'Svelte' },
      ],
    })
    expect(serializePoll(poll)).toMatchInlineSnapshot(`
      "<poll>
      Question: Which framework?
      - React
      - Vue
      - Svelte
      </poll>"
    `)
  })

  test('returns empty string for null poll', () => {
    expect(serializePoll(null)).toBe('')
  })

  test('skips answers with no text', () => {
    const poll = fakePoll({
      question: 'Pick one',
      answers: [
        { id: 1, text: 'Option A' },
        { id: 2, text: null },
      ],
    })
    expect(serializePoll(poll)).toMatchInlineSnapshot(`
      "<poll>
      Question: Pick one
      - Option A
      </poll>"
    `)
  })
})

describe('serializeMessageSnapshots', () => {
  function fakeSnapshot(data: {
    content?: string
    embeds?: Embed[]
  }): MessageSnapshot {
    return {
      content: data.content ?? '',
      embeds: data.embeds ?? [],
    } as unknown as MessageSnapshot
  }

  function fakeEmbed(data: {
    title?: string
    description?: string
    url?: string
    author?: { name: string }
    footer?: { text: string }
    fields?: Array<{ name: string; value: string }>
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

  test('serializes a forwarded message with content', () => {
    const snapshots = fakeCollection<string, MessageSnapshot>([
      ['1', fakeSnapshot({ content: 'Hello from another channel' })],
    ])
    expect(serializeMessageSnapshots(snapshots)).toMatchInlineSnapshot(`
      "<forwarded-message>
      Hello from another channel
      </forwarded-message>"
    `)
  })

  test('serializes forwarded message with content and embeds', () => {
    const snapshots = fakeCollection<string, MessageSnapshot>([
      [
        '1',
        fakeSnapshot({
          content: 'Check this out',
          embeds: [fakeEmbed({ title: 'Link Preview', description: 'A cool site' })],
        }),
      ],
    ])
    expect(serializeMessageSnapshots(snapshots)).toMatchInlineSnapshot(`
      "<forwarded-message>
      Check this out

      <embed>
      Title: Link Preview
      A cool site
      </embed>
      </forwarded-message>"
    `)
  })

  test('returns empty string for no snapshots', () => {
    const empty = fakeCollection<string, MessageSnapshot>([])
    expect(serializeMessageSnapshots(empty)).toBe('')
  })

  test('skips snapshots with no content', () => {
    const snapshots = fakeCollection<string, MessageSnapshot>([
      ['1', fakeSnapshot({})],
    ])
    expect(serializeMessageSnapshots(snapshots)).toBe('')
  })

  test('serializes multiple forwarded messages', () => {
    const snapshots = fakeCollection<string, MessageSnapshot>([
      ['1', fakeSnapshot({ content: 'First forwarded' })],
      ['2', fakeSnapshot({ content: 'Second forwarded' })],
    ])
    expect(serializeMessageSnapshots(snapshots)).toMatchInlineSnapshot(`
      "<forwarded-message>
      First forwarded
      </forwarded-message>

      <forwarded-message>
      Second forwarded
      </forwarded-message>"
    `)
  })
})
