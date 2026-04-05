import { describe, test, expect } from 'vitest'
import { extractLeadingOpencodeCommand } from './opencode-command-detection.js'
import type { RegisteredUserCommand } from './store.js'

const fixtures: RegisteredUserCommand[] = [
  {
    name: 'build',
    discordCommandName: 'build-cmd',
    description: 'build the project',
    source: 'command',
  },
  {
    name: 'namespace:foo',
    discordCommandName: 'namespace-foo-cmd',
    description: 'namespaced',
    source: 'command',
  },
  {
    name: 'review',
    discordCommandName: 'review-skill',
    description: 'review skill',
    source: 'skill',
  },
  {
    name: 'plan',
    discordCommandName: 'plan-mcp-prompt',
    description: 'plan via mcp',
    source: 'mcp',
  },
]

describe('extractLeadingOpencodeCommand', () => {
  test('plain /build with args', () => {
    expect(
      extractLeadingOpencodeCommand('/build foo bar', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "foo bar",
          "name": "build",
        },
      }
    `)
  })

  test('plain /build no args', () => {
    expect(extractLeadingOpencodeCommand('/build', fixtures))
      .toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "",
          "name": "build",
        },
      }
    `)
  })

  test('/build-cmd suffix resolves to build', () => {
    expect(
      extractLeadingOpencodeCommand('/build-cmd hello world', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "hello world",
          "name": "build",
        },
      }
    `)
  })

  test('-skill suffix', () => {
    expect(
      extractLeadingOpencodeCommand('/review-skill a b', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "a b",
          "name": "review",
        },
      }
    `)
  })

  test('-mcp-prompt suffix', () => {
    expect(
      extractLeadingOpencodeCommand('/plan-mcp-prompt go', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "go",
          "name": "plan",
        },
      }
    `)
  })

  test('original namespaced name with colon', () => {
    expect(
      extractLeadingOpencodeCommand('/namespace:foo arg', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "arg",
          "name": "namespace:foo",
        },
      }
    `)
  })

  test('discord-sanitized namespaced name', () => {
    expect(
      extractLeadingOpencodeCommand('/namespace-foo-cmd arg', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "arg",
          "name": "namespace:foo",
        },
      }
    `)
  })

  test('kimaki-cli prefix stripped', () => {
    expect(
      extractLeadingOpencodeCommand(
        '» **kimaki-cli:** /build foo bar',
        fixtures,
      ),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "foo bar",
          "name": "build",
        },
      }
    `)
  })

  test('queue-style user prefix stripped', () => {
    expect(
      extractLeadingOpencodeCommand('» **Tommy:** /build hey', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "hey",
          "name": "build",
        },
      }
    `)
  })

  test('username containing asterisk is handled', () => {
    expect(
      extractLeadingOpencodeCommand('» **A*B:** /build hi', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "hi",
          "name": "build",
        },
      }
    `)
  })

  test('multiline args', () => {
    expect(
      extractLeadingOpencodeCommand('/build line1\nline2\nline3', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "line1
      line2
      line3",
          "name": "build",
        },
      }
    `)
  })

  test('unknown command returns null', () => {
    expect(
      extractLeadingOpencodeCommand('/nothing here', fixtures),
    ).toMatchInlineSnapshot(`null`)
  })

  test('no leading slash returns null', () => {
    expect(
      extractLeadingOpencodeCommand('hello /build', fixtures),
    ).toMatchInlineSnapshot(`null`)
  })

  test('just slash returns null', () => {
    expect(extractLeadingOpencodeCommand('/', fixtures)).toMatchInlineSnapshot(
      `null`,
    )
  })

  test('empty string returns null', () => {
    expect(extractLeadingOpencodeCommand('', fixtures)).toMatchInlineSnapshot(
      `null`,
    )
  })

  test('empty registry returns null even for known-looking commands', () => {
    expect(extractLeadingOpencodeCommand('/build foo', [])).toMatchInlineSnapshot(
      `null`,
    )
  })

  test('leading whitespace before slash still matches', () => {
    expect(
      extractLeadingOpencodeCommand('   /build foo', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "foo",
          "name": "build",
        },
      }
    `)
  })

  test('suffix strip does not clobber a command whose name happens to end in -cmd', () => {
    const custom: RegisteredUserCommand[] = [
      {
        name: 'deploy-cmd',
        discordCommandName: 'deploy-cmd-cmd',
        description: '',
        source: 'command',
      },
    ]
    expect(
      extractLeadingOpencodeCommand('/deploy-cmd now', custom),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "now",
          "name": "deploy-cmd",
        },
      }
    `)
  })
})
