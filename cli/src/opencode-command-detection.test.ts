import { describe, test, expect } from 'vitest'
import {
  extractLeadingOpencodeCommand,
  extractOpencodeCommandReference,
} from './opencode-command-detection.js'
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

  test('kimaki-cli prefix on its own line', () => {
    expect(
      extractLeadingOpencodeCommand(
        '» **kimaki-cli:**\n/build foo bar',
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

  test('queue-style user prefix on its own line', () => {
    expect(
      extractLeadingOpencodeCommand('» **Tommy:**\n/build hey', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "hey",
          "name": "build",
        },
      }
    `)
  })

  test('username containing asterisk on its own line', () => {
    expect(
      extractLeadingOpencodeCommand('» **A*B:**\n/build hi', fixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "hi",
          "name": "build",
        },
      }
    `)
  })

  test('Context from thread wrapping still detects command', () => {
    const wrapped =
      'Context from thread:\nsome starter text\n\nUser request:\n/build foo'
    expect(extractLeadingOpencodeCommand(wrapped, fixtures))
      .toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "foo",
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

  test('no leading slash on any line returns null', () => {
    expect(
      extractLeadingOpencodeCommand('hello /build\nmore text', fixtures),
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

  test('empty registry returns null for tokens without Discord suffix', () => {
    expect(extractLeadingOpencodeCommand('/build foo', [])).toMatchInlineSnapshot(
      `null`,
    )
  })

  test('empty registry fallback: -cmd suffix strips and returns base name', () => {
    expect(
      extractLeadingOpencodeCommand('/hello-test-cmd', []),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "",
          "name": "hello-test",
        },
      }
    `)
  })

  test('empty registry fallback: -skill suffix with args', () => {
    expect(
      extractLeadingOpencodeCommand('/review-skill check auth', []),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "check auth",
          "name": "review",
        },
      }
    `)
  })

  test('empty registry fallback skips non-suffixed, matches suffixed on next line', () => {
    expect(
      extractLeadingOpencodeCommand('/unknown\n/deploy-cmd now', []),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "now",
          "name": "deploy",
        },
      }
    `)
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

  test('first matching line wins', () => {
    const prompt = 'noise line\n/build first args\n/review second args'
    expect(extractLeadingOpencodeCommand(prompt, fixtures))
      .toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "first args",
          "name": "build",
        },
      }
    `)
  })

  test('unknown command on one line, known on next', () => {
    const prompt = '/unknown foo\n/build bar'
    expect(extractLeadingOpencodeCommand(prompt, fixtures))
      .toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "bar",
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

const optionFixtures: RegisteredUserCommand[] = [
  {
    name: 'start-work',
    discordCommandName: 'start-work',
    description: 'start a work session',
    source: 'command',
  },
  {
    name: 'build',
    discordCommandName: 'build-cmd',
    description: 'build the project',
    source: 'command',
  },
]

describe('extractOpencodeCommandReference', () => {
  test('detects a command in the middle of an option description', () => {
    expect(
      extractOpencodeCommandReference(
        'Execute now with /start-work {name}. Plan looks solid.',
        optionFixtures,
      ),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "",
          "name": "start-work",
        },
      }
    `)
  })

  test('detects a backtick-wrapped command and drops placeholder args', () => {
    expect(
      extractOpencodeCommandReference(
        'Execute now with `/start-work {name}`. Plan looks solid.',
        optionFixtures,
      ),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "",
          "name": "start-work",
        },
      }
    `)
  })

  test('resolves a discord-suffixed token mid-text', () => {
    expect(
      extractOpencodeCommandReference('Run /build-cmd to compile', optionFixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "",
          "name": "build",
        },
      }
    `)
  })

  test('ignores unregistered slash tokens (URLs, prose)', () => {
    expect(
      extractOpencodeCommandReference(
        'See https://example.com/start and/or the docs',
        optionFixtures,
      ),
    ).toMatchInlineSnapshot(`null`)
  })

  test('returns the first registered command when several are referenced', () => {
    expect(
      extractOpencodeCommandReference('first /build then /start-work', optionFixtures),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "arguments": "",
          "name": "build",
        },
      }
    `)
  })

  test('empty string returns null', () => {
    expect(extractOpencodeCommandReference('', optionFixtures)).toMatchInlineSnapshot(
      `null`,
    )
  })

  test('plain label with no slash returns null', () => {
    expect(
      extractOpencodeCommandReference('Start Work', optionFixtures),
    ).toMatchInlineSnapshot(`null`)
  })
})
