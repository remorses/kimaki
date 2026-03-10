import { PermissionsBitField } from 'discord.js'
import { describe, expect, test } from 'vitest'
import { hasKimakiBotPermission } from './platform/discord-adapter.js'
import { splitMarkdownForDiscord } from './discord-utils.js'

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
})

describe('hasKimakiBotPermission', () => {
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
