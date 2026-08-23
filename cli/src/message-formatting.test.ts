import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, test, expect } from 'vitest'
import { formatBashToolTitle, formatPart, formatTaskToolTitle, formatTodoList, getTextAttachments, serializeEmbeds, serializePoll, serializeMessageSnapshots, TEXT_ATTACHMENT_INLINE_LIMIT_BYTES } from './message-formatting.js'
import { getDataDir } from './config.js'
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

describe('formatTaskToolTitle', () => {
  function taskPart({
    status,
    input = {},
    title = '',
    sessionId,
  }: {
    status: 'running' | 'completed'
    input?: { description?: string; subagent_type?: string }
    title?: string
    sessionId?: string
  }): Extract<Part, { type: 'tool' }> {
    const base = {
      id: 'prt_task',
      type: 'tool' as const,
      tool: 'task',
      callID: 'call_task',
      sessionID: 'ses_parent',
      messageID: 'msg_assistant',
    }
    if (status === 'completed') {
      return {
        ...base,
        state: {
          status,
          input,
          output: '',
          title,
          metadata: sessionId ? { sessionId } : {},
          time: { start: 1, end: 2 },
        },
      }
    }
    return {
      ...base,
      state: {
        status,
        input,
        title,
        metadata: sessionId ? { sessionId } : {},
        time: { start: 1 },
      },
    }
  }

  test('uses the running task title when OpenAI omits the description', () => {
    expect(
      formatTaskToolTitle(
        taskPart({
          status: 'running',
          input: { subagent_type: 'general' },
          title: 'Classify pending changes',
          sessionId: 'ses_child',
        }),
      ),
    ).toMatchInlineSnapshot(`"┣ general **Classify pending changes**"`)
  })

  test('prefers input description on running parts', () => {
    expect(
      formatTaskToolTitle(
        taskPart({
          status: 'running',
          input: { description: 'inspect repo', subagent_type: 'explore' },
          title: 'ignored title',
          sessionId: 'ses_child',
        }),
      ),
    ).toMatchInlineSnapshot(`"┣ explore **inspect repo**"`)
  })

  test('does not format completed parts so Discord does not post the line at the end', () => {
    expect(
      formatTaskToolTitle(
        taskPart({
          status: 'completed',
          input: { subagent_type: 'general' },
          title: 'Classify pending changes',
          sessionId: 'ses_child',
        }),
      ),
    ).toBe('')
  })

  test('skips running parts until the child session and title exist', () => {
    expect(
      formatTaskToolTitle(
        taskPart({
          status: 'running',
          input: {},
        }),
      ),
    ).toBe('')
  })
})

describe('formatBashToolTitle', () => {
  test('short single-line command shown in full', () => {
    expect(formatBashToolTitle({ command: 'echo hello' })).toMatchInlineSnapshot(`" _echo hello_"`)
  })

  test('multiline command without description truncates to first line', () => {
    expect(
      formatBashToolTitle({ command: 'echo hello\necho world\necho done' }),
    ).toMatchInlineSnapshot(`" _echo hello…_"`)
  })

  test('long single-line command is truncated with ellipsis', () => {
    const longCommand = 'a'.repeat(150)
    const result = formatBashToolTitle({ command: longCommand })
    expect(result).toContain('…')
    expect(result.length).toBeLessThan(150)
  })

  test('description is preferred over truncated command when present', () => {
    expect(
      formatBashToolTitle({
        command: 'echo hello\necho world',
        description: 'Print greeting',
      }),
    ).toMatchInlineSnapshot(`" _Print greeting_"`)
  })

  test('stateTitle used as last resort', () => {
    expect(
      formatBashToolTitle({ command: '', stateTitle: 'Running tests' }),
    ).toMatchInlineSnapshot(`" _Running tests_"`)
  })

  test('empty inputs return empty string', () => {
    expect(formatBashToolTitle({ command: '' })).toBe('')
  })

  test('leading blank line skipped, uses first meaningful line', () => {
    expect(
      formatBashToolTitle({ command: '\npnpm test\npnpm build' }),
    ).toMatchInlineSnapshot(`" _pnpm test…_"`)
  })

  test('whitespace-only first line skipped', () => {
    expect(
      formatBashToolTitle({ command: '   \npnpm test' }),
    ).toMatchInlineSnapshot(`" _pnpm test…_"`)
  })

  test('no description field (new opencode) with multiline command', () => {
    // This is the exact scenario that was broken: opencode removed `description`
    // from the bash tool schema, so multiline commands rendered as just "┣ bash"
    const command = 'git diff HEAD~1 --stat && git log --oneline -5'
    expect(formatBashToolTitle({ command: command + '\n' + 'echo done' })).toMatchInlineSnapshot(
      `" _git diff HEAD\\~1 --stat && git log --oneline -5…_"`,
    )
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

describe('getTextAttachments', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(impl: (url: string) => Promise<Response>) {
    const fetchFn = async (input: string | URL | Request) => impl(String(input))
    fetchFn.preconnect = () => {}
    globalThis.fetch = fetchFn
  }

  function messageWithAttachments(
    attachments: Array<{
      id: string
      name: string
      contentType: string
      url: string
      size: number
    }>,
  ) {
    return {
      attachments: new Map(attachments.map((attachment) => {
        return [attachment.id, attachment]
      })),
    } as unknown as Message
  }

  function snapshotAttachments(result: string) {
    return result.replaceAll(getDataDir(), '<dataDir>')
  }

  test('inlines small text files and saves them locally', async () => {
    stubFetch(async () => {
      return new Response('hello from file', { status: 200 })
    })

    const result = await getTextAttachments(
      messageWithAttachments([
        {
          id: 'att1',
          name: 'notes.txt',
          contentType: 'text/plain',
          url: 'https://cdn.example/notes.txt',
          size: 16,
        },
      ]),
    )

    const savedPath = path.join(getDataDir(), 'attachments', 'att1-notes.txt')
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('hello from file')
    expect(result).toContain('https://cdn.example/notes.txt')
    expect(result).toContain(savedPath)
    expect(snapshotAttachments(result)).toMatchInlineSnapshot(`
      "<attachment filename="notes.txt" mime="text/plain" size="16" url="https://cdn.example/notes.txt" path="<dataDir>/attachments/att1-notes.txt">
      hello from file
      </attachment>"
    `)
  })

  test('saves large text files locally without inlining contents', async () => {
    stubFetch(async () => {
      return new Response('SHOULD NOT BE INLINED', { status: 200 })
    })

    const result = await getTextAttachments(
      messageWithAttachments([
        {
          id: 'att2',
          name: 'huge.log',
          contentType: 'text/plain',
          url: 'https://cdn.discordapp.com/attachments/1/2/huge.log',
          size: TEXT_ATTACHMENT_INLINE_LIMIT_BYTES + 1,
        },
      ]),
    )

    const savedPath = path.join(getDataDir(), 'attachments', 'att2-huge.log')
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('SHOULD NOT BE INLINED')
    expect(result).not.toContain('SHOULD NOT BE INLINED')
    expect(result).toContain('https://cdn.discordapp.com/attachments/1/2/huge.log')
    expect(result).toContain(savedPath)
    expect(result).toContain('text/plain')
    expect(result).toContain(String(TEXT_ATTACHMENT_INLINE_LIMIT_BYTES + 1))
    expect(snapshotAttachments(result)).toMatchInlineSnapshot(`
      "<attachment filename="huge.log" mime="text/plain" size="65537" url="https://cdn.discordapp.com/attachments/1/2/huge.log" path="<dataDir>/attachments/att2-huge.log" large="true">
      This file is large (64 KB, text/plain). Contents were not inlined to save context. Read the local path.
      </attachment>"
    `)
  })

  test('still inlines large prompt.md attachments from kimaki send', async () => {
    stubFetch(async () => {
      return new Response('the actual long prompt', { status: 200 })
    })

    const result = await getTextAttachments(
      messageWithAttachments([
        {
          id: 'att3',
          name: 'prompt.md',
          contentType: 'text/markdown',
          url: 'https://cdn.example/prompt.md',
          size: TEXT_ATTACHMENT_INLINE_LIMIT_BYTES + 1,
        },
      ]),
    )

    const savedPath = path.join(getDataDir(), 'attachments', 'att3-prompt.md')
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('the actual long prompt')
    expect(result).toContain('the actual long prompt')
    expect(result).toContain('https://cdn.example/prompt.md')
    expect(result).toContain(savedPath)
    expect(snapshotAttachments(result)).toMatchInlineSnapshot(`
      "<attachment filename="prompt.md" mime="text/markdown" size="65537" url="https://cdn.example/prompt.md" path="<dataDir>/attachments/att3-prompt.md">
      the actual long prompt
      </attachment>"
    `)
  })

  test('keeps small files inlined next to large file references', async () => {
    stubFetch(async (url) => {
      if (url.includes('small.txt')) {
        return new Response('tiny', { status: 200 })
      }
      return new Response('SHOULD NOT BE INLINED', { status: 200 })
    })

    const result = await getTextAttachments(
      messageWithAttachments([
        {
          id: 'att4',
          name: 'small.txt',
          contentType: 'text/plain',
          url: 'https://cdn.example/small.txt',
          size: 4,
        },
        {
          id: 'att5',
          name: 'dump.json',
          contentType: 'application/json',
          url: 'https://cdn.example/dump.json',
          size: TEXT_ATTACHMENT_INLINE_LIMIT_BYTES + 50,
        },
      ]),
    )

    expect(result).toContain('tiny')
    expect(result).not.toContain('SHOULD NOT BE INLINED')
    expect(result).toContain('https://cdn.example/small.txt')
    expect(result).toContain('https://cdn.example/dump.json')
    expect(result).toContain(path.join(getDataDir(), 'attachments', 'att4-small.txt'))
    expect(result).toContain(path.join(getDataDir(), 'attachments', 'att5-dump.json'))
    expect(result).toContain('application/json')
    expect(snapshotAttachments(result)).toMatchInlineSnapshot(`
      "<attachment filename="small.txt" mime="text/plain" size="4" url="https://cdn.example/small.txt" path="<dataDir>/attachments/att4-small.txt">
      tiny
      </attachment>

      <attachment filename="dump.json" mime="application/json" size="65586" url="https://cdn.example/dump.json" path="<dataDir>/attachments/att5-dump.json" large="true">
      This file is large (64 KB, application/json). Contents were not inlined to save context. Read the local path.
      </attachment>"
    `)
  })
})
