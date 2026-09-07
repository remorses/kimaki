import { PermissionsBitField, type Message } from 'discord.js'
import { afterEach, describe, expect, test } from 'vitest'
import {
  hasKimakiAdminPermission,
  hasKimakiBotPermission,
  raceDiscordRename,
  resolveFooterMentionUserId,
  resolveGuildMessageMember,
  resolveThreadFooterMentionUserId,
  splitMarkdownForDiscord,
} from './discord-utils.js'
import type { ThreadChannel } from 'discord.js'
import { store } from './store.js'

describe('splitMarkdownForDiscord', () => {
  test('never returns chunks over the max length with code fences', () => {
    const maxLength = 2000
    const header = '## Summary of Current Architecture\n\n'
    const codeFenceStart = '```\n'
    const codeFenceEnd = '\n```\n'
    const codeLine = 'x'.repeat(180)
    const codeBlock = Array.from({ length: 20 })
      .map(() => codeLine)
      .join('\n')
    const markdown = `${header}${codeFenceStart}${codeBlock}${codeFenceEnd}`

    const chunks = splitMarkdownForDiscord({ content: markdown, maxLength })

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLength)
    }
  })

  // Without the lineLength fix for opening fences on non-empty chunks, the opening
  // fence text "```\n" gets appended without being counted in the overflow check.
  // When the chunk is later flushed with a closing fence, it exceeds maxLength.
  test('opening fence on non-empty chunk is counted in overflow check', () => {
    const maxLength = 60
    // 55 chars of text + paragraph break, then a code block.
    // The text fills the chunk to ~57 chars. The opening fence "```\n" (4 chars)
    // would push to 61 if not counted, then flushing adds "```\n" (4 more) = 65.
    const markdown = 'a'.repeat(55) + '\n\n```\nshort code\n```\n'

    const chunks = splitMarkdownForDiscord({ content: markdown, maxLength })

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLength)
    }
  })

  test('list item code block keeps newline before fence when splitting', () => {
    const content = `- File: playwriter/src/aria-snapshot.ts
- Add helper function (~line 477, after isTextRole):
  \`\`\`ts
  function isSubstringOfAny(needle: string, haystack: Set<string>): boolean {
    for (const str of haystack) {
      if (str.includes(needle)) {
        return true
      }
    }
    return false
  }
  \`\`\`
`

    const result = splitMarkdownForDiscord({ content, maxLength: 80 })
    expect(result).toMatchInlineSnapshot(`
      [
        "- File: playwriter/src/aria-snapshot.ts
      ",
        "- Add helper function (~line 477, after isTextRole):
        \`\`\`ts
      ",
        "  function isSubstringOfAny(needle: string, haystack: Set<string>): boolean {
      ",
        "    for (const str of haystack) {
            if (str.includes(needle)) {
      ",
        "        return true
            }
          }
          return false
        }
        \`\`\`
      ",
      ]
    `)
  })

  test('task list code block does not duplicate checkbox marker when splitting', () => {
    const content = `- [ ] Do thing
  \`\`\`sh
  echo hi
  \`\`\`
`

    const result = splitMarkdownForDiscord({ content, maxLength: 80 })
    expect(result.join('')).toContain('- [ ] Do thing\n')
    expect(result.join('')).not.toContain('- [ ] [ ] Do thing')
    expect(result).toMatchInlineSnapshot(`
      [
        "- [ ] Do thing
        \`\`\`sh
        echo hi
        \`\`\`
      ",
      ]
    `)
  })
})

describe('hasKimakiBotPermission', () => {
  afterEach(() => {
    store.setState({ allowAllUsers: false })
  })

  test('allows any member when allowAllUsers is enabled', () => {
    store.setState({ allowAllUsers: true })
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(true)
  })

  test('still blocks no-kimaki role even when allowAllUsers is enabled', () => {
    store.setState({ allowAllUsers: true })
    const noKimakiRoleId = '222'
    const guild = {
      ownerId: 'owner-id',
      roles: {
        cache: new Map([
          [noKimakiRoleId, { id: noKimakiRoleId, name: 'no-kimaki' }],
        ]),
      },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [noKimakiRoleId],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(false)
  })

  test('allows API interaction member when kimaki role exists', () => {
    const kimakiRoleId = '111'
    const guild = {
      ownerId: 'owner-id',
      roles: {
        cache: new Map([
          [kimakiRoleId, { id: kimakiRoleId, name: 'Kimaki' }],
        ]),
      },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [kimakiRoleId],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(true)
  })

  test('allows API interaction member with ManageGuild permission', () => {
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: PermissionsBitField.Flags.ManageGuild.toString(),
      roles: [],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(true)
  })

  test('denies API interaction member with no role, owner, or admin rights', () => {
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(false)
  })
})

describe('hasKimakiAdminPermission', () => {
  afterEach(() => {
    store.setState({ allowAllUsers: false })
  })

  test('denies unprivileged member even when allowAllUsers is enabled', () => {
    store.setState({ allowAllUsers: true })
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [],
    } as any

    expect(hasKimakiAdminPermission(member, guild)).toBe(false)
  })

  test('allows admin even when allowAllUsers is enabled', () => {
    store.setState({ allowAllUsers: true })
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: PermissionsBitField.Flags.Administrator.toString(),
      roles: [],
    } as any

    expect(hasKimakiAdminPermission(member, guild)).toBe(true)
  })
})

describe('resolveGuildMessageMember', () => {
  test('uses hydrated message member without fetching', async () => {
    const member = { id: 'member-id' }
    const message = {
      guild: {
        members: {
          fetch() {
            throw new Error('should not fetch')
          },
        },
      },
      member,
      author: { id: 'member-id' },
      id: 'message-id',
    } as unknown as Message

    await expect(resolveGuildMessageMember(message)).resolves.toBe(member)
  })

  test('fetches missing guild message member', async () => {
    const member = { id: 'member-id' }
    const message = {
      guild: {
        members: {
          fetch(id: string) {
            expect(id).toBe('member-id')
            return Promise.resolve(member)
          },
        },
      },
      member: null,
      author: { id: 'member-id' },
      id: 'message-id',
    } as unknown as Message

    await expect(resolveGuildMessageMember(message)).resolves.toBe(member)
  })

  test('denies when missing guild message member cannot be fetched', async () => {
    const message = {
      guild: {
        members: {
          fetch() {
            return Promise.reject(new Error('missing member'))
          },
        },
      },
      member: null,
      author: { id: 'member-id' },
      id: 'message-id',
    } as unknown as Message

    await expect(resolveGuildMessageMember(message)).resolves.toBe(null)
  })
})

describe('resolveFooterMentionUserId', () => {
  test('uses the session user when it is not the bot', () => {
    expect(resolveFooterMentionUserId({
      sessionUserId: 'user-1',
      botUserId: 'bot-1',
      threadOwnerId: 'bot-1',
      members: [
        { id: 'bot-1', bot: true, joinedTimestamp: 1 },
        { id: 'user-2', bot: false, joinedTimestamp: 2 },
      ],
    })).toBe('user-1')
  })

  test('skips bots and uses the earliest human member when the bot created the thread', () => {
    expect(resolveFooterMentionUserId({
      sessionUserId: 'bot-1',
      botUserId: 'bot-1',
      threadOwnerId: 'bot-1',
      members: [
        { id: 'bot-1', bot: true, joinedTimestamp: 1 },
        { id: 'other-bot', bot: true, joinedTimestamp: 2 },
        { id: 'user-3', bot: false, joinedTimestamp: 4 },
        { id: 'user-2', bot: false, joinedTimestamp: 3 },
      ],
    })).toBe('user-2')
  })

  test('does not mention anyone when the bot created the thread and no human member exists', () => {
    expect(resolveFooterMentionUserId({
      sessionUserId: 'bot-1',
      botUserId: 'bot-1',
      threadOwnerId: 'bot-1',
      members: [
        { id: 'bot-1', bot: true, joinedTimestamp: 1 },
        { id: 'other-bot', bot: true, joinedTimestamp: 2 },
      ],
    })).toBeUndefined()
  })

  test('uses the first human member when the bot created the thread and no session user is set', () => {
    expect(resolveFooterMentionUserId({
      sessionUserId: undefined,
      botUserId: 'bot-1',
      threadOwnerId: 'bot-1',
      members: [
        { id: 'bot-1', bot: true, joinedTimestamp: 1 },
        { id: 'user-2', bot: false, joinedTimestamp: 2 },
      ],
    })).toBe('user-2')
  })

  test('does not mention a member whose bot flag is unknown', () => {
    expect(resolveFooterMentionUserId({
      sessionUserId: undefined,
      botUserId: 'bot-1',
      threadOwnerId: 'bot-1',
      members: [
        { id: 'bot-1', bot: true, joinedTimestamp: 1 },
        { id: 'maybe-user', joinedTimestamp: 2 },
      ],
    })).toBeUndefined()
  })
})

function fakeThread({
  ownerId,
  botUserId,
  members,
  onFetch,
}: {
  ownerId: string
  botUserId: string
  members: Array<{ id: string; bot?: boolean; joinedTimestamp?: number | null }>
  onFetch?: () => Promise<Map<string, { id: string; user?: { bot?: boolean }; joinedTimestamp?: number | null }>>
}): ThreadChannel {
  const cache = new Map(members.map((member) => [
    member.id,
    {
      id: member.id,
      user: member.bot === undefined ? undefined : { bot: member.bot },
      joinedTimestamp: member.joinedTimestamp ?? null,
    },
  ]))
  return {
    ownerId,
    client: { user: { id: botUserId } },
    members: {
      cache,
      fetch: onFetch ?? (() => {
        throw new Error('should not fetch thread members')
      }),
    },
  } as ThreadChannel
}

describe('resolveThreadFooterMentionUserId', () => {
  test('does not fetch when a human session user is already known', async () => {
    await expect(resolveThreadFooterMentionUserId({
      sessionUserId: 'user-1',
      thread: fakeThread({
        ownerId: 'bot-1',
        botUserId: 'bot-1',
        members: [{ id: 'bot-1', bot: true }],
      }),
    })).resolves.toBe('user-1')
  })

  test('does not fetch when the thread owner is not the bot', async () => {
    await expect(resolveThreadFooterMentionUserId({
      sessionUserId: undefined,
      thread: fakeThread({
        ownerId: 'user-1',
        botUserId: 'bot-1',
        members: [{ id: 'user-1', bot: false }],
      }),
    })).resolves.toBeUndefined()
  })

  test('uses cached humans without fetching', async () => {
    await expect(resolveThreadFooterMentionUserId({
      sessionUserId: undefined,
      thread: fakeThread({
        ownerId: 'bot-1',
        botUserId: 'bot-1',
        members: [
          { id: 'bot-1', bot: true, joinedTimestamp: 1 },
          { id: 'user-2', bot: false, joinedTimestamp: 2 },
        ],
      }),
    })).resolves.toBe('user-2')
  })

  test('fetches only when the bot owns the thread and no human is cached', async () => {
    let fetched = false
    const thread = fakeThread({
      ownerId: 'bot-1',
      botUserId: 'bot-1',
      members: [{ id: 'bot-1', bot: true, joinedTimestamp: 1 }],
      onFetch: async () => {
        fetched = true
        return new Map([
          ['bot-1', { id: 'bot-1', user: { bot: true }, joinedTimestamp: 1 }],
          ['user-2', { id: 'user-2', user: { bot: false }, joinedTimestamp: 2 }],
        ])
      },
    })
    await expect(resolveThreadFooterMentionUserId({
      sessionUserId: undefined,
      thread,
    })).resolves.toBe('user-2')
    expect(fetched).toBe(true)
  })
})

describe('raceDiscordRename', () => {
  test('returns timeout when rename hangs', async () => {
    const result = await raceDiscordRename({
      rename: new Promise(() => {}),
      timeoutMs: 20,
    })
    expect(result).toBe('timeout')
  })

  test('returns rename result when it finishes first', async () => {
    const result = await raceDiscordRename({
      rename: Promise.resolve('ok'),
      timeoutMs: 1000,
    })
    expect(result).toBe('ok')
  })
})
