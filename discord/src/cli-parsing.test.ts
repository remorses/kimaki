// Regression tests for CLI argument parsing around Discord ID string preservation.
import { describe, expect, test } from 'vitest'
import { goke } from 'goke'

function createCliForIdParsing() {
  const cli = goke('kimaki')

  cli
    .command('send', 'Send a message')
    .option('-c, --channel <channelId>', 'Discord channel ID')
    .option('--thread <threadId>', 'Thread ID')
    .option('--session <sessionId>', 'Session ID')
    .option('--send-at <schedule>', 'Schedule')

  cli.command('session archive <threadId>', 'Archive a thread')
  cli
    .command('session search <query>', 'Search sessions')
    .option('--channel <channelId>', 'Discord channel ID')
    .option('--project <path>', 'Project path')
  cli
    .command('session export-events-jsonl', 'Export in-memory events to JSONL')
    .option('--session <sessionId>', 'Session ID')
    .option('--out <file>', 'Output path')

  cli
    .command('add-project', 'Add a project')
    .option('-g, --guild <guildId>', 'Discord guild/server ID')

  cli.command('task delete <id>', 'Delete task')
  cli.command('anthropic-accounts list', 'List stored Anthropic accounts').hidden()
  cli.command('anthropic-accounts remove <index>', 'Remove stored Anthropic account').hidden()

  return cli
}

describe('goke CLI ID parsing', () => {
  test('keeps large Discord IDs as strings', () => {
    const cli = createCliForIdParsing()
    const channelId = '1234567890123456789'
    const threadId = '9876543210987654321'
    const sessionId = '1111222233334444555'

    const channelResult = cli.parse(
      ['node', 'kimaki', 'send', '--channel', channelId],
      {
        run: false,
      },
    )
    expect(channelResult.options.channel).toBe(channelId)
    expect(typeof channelResult.options.channel).toBe('string')

    const threadResult = cli.parse(
      ['node', 'kimaki', 'send', '--thread', threadId],
      { run: false },
    )
    expect(threadResult.options.thread).toBe(threadId)
    expect(typeof threadResult.options.thread).toBe('string')

    const sessionResult = cli.parse(
      ['node', 'kimaki', 'send', '--session', sessionId],
      {
        run: false,
      },
    )
    expect(sessionResult.options.session).toBe(sessionId)
    expect(typeof sessionResult.options.session).toBe('string')
  })

  test('preserves leading zeros in Discord IDs', () => {
    const cli = createCliForIdParsing()
    const guildId = '001230045600789'

    const result = cli.parse(
      ['node', 'kimaki', 'add-project', '--guild', guildId],
      { run: false },
    )

    expect(result.options.guild).toBe(guildId)
    expect(typeof result.options.guild).toBe('string')
  })

  test('keeps session archive thread ID as string', () => {
    const cli = createCliForIdParsing()
    const threadId = '0098765432109876543'

    const result = cli.parse(
      ['node', 'kimaki', 'session', 'archive', threadId],
      {
        run: false,
      },
    )

    expect(result.args[0]).toBe(threadId)
    expect(typeof result.args[0]).toBe('string')
  })

  test('keeps session search regex and channel ID as strings', () => {
    const cli = createCliForIdParsing()
    const channelId = '0012345678901234567'
    const query = '/error\\s+42/i'

    const result = cli.parse(
      ['node', 'kimaki', 'session', 'search', query, '--channel', channelId],
      {
        run: false,
      },
    )

    expect(result.args[0]).toBe(query)
    expect(typeof result.args[0]).toBe('string')
    expect(result.options.channel).toBe(channelId)
    expect(typeof result.options.channel).toBe('string')
  })

  test('keeps session export options as strings', () => {
    const cli = createCliForIdParsing()
    const sessionId = '001111222233334444'
    const outPath = './tmp/session-events.jsonl'

    const result = cli.parse(
      [
        'node',
        'kimaki',
        'session',
        'export-events-jsonl',
        '--session',
        sessionId,
        '--out',
        outPath,
      ],
      {
        run: false,
      },
    )

    expect(result.options.session).toBe(sessionId)
    expect(typeof result.options.session).toBe('string')
    expect(result.options.out).toBe(outPath)
    expect(typeof result.options.out).toBe('string')
  })

  test('keeps --send-at cron string intact', () => {
    const cli = createCliForIdParsing()
    const cron = '0 9 * * 1'

    const result = cli.parse(['node', 'kimaki', 'send', '--send-at', cron], {
      run: false,
    })

    expect(result.options.sendAt).toBe(cron)
    expect(typeof result.options.sendAt).toBe('string')
  })

  test('keeps task delete ID as string before validation', () => {
    const cli = createCliForIdParsing()
    const taskId = '0012345'

    const result = cli.parse(['node', 'kimaki', 'task', 'delete', taskId], {
      run: false,
    })

    expect(result.args[0]).toBe(taskId)
    expect(typeof result.args[0]).toBe('string')
  })

  test('hidden anthropic account commands still parse', () => {
    const cli = createCliForIdParsing()

    const result = cli.parse(
      ['node', 'kimaki', 'anthropic-accounts', 'remove', '2'],
      { run: false },
    )

    expect(result.args[0]).toBe('2')
    expect(typeof result.args[0]).toBe('string')
  })

  test('hidden anthropic account commands are excluded from help output', () => {
    const stdout = {
      text: '',
      write(data: string | Uint8Array) {
        this.text += String(data)
      },
    }

    const cli = goke('kimaki', { stdout: stdout as never })
    cli.command('send', 'Send a message')
    cli.command('anthropic-accounts list', 'List stored Anthropic accounts').hidden()
    cli.help()
    cli.parse(['node', 'kimaki', '--help'], { run: false })

    expect(stdout.text).toContain('send')
    expect(stdout.text).not.toContain('anthropic-accounts')
  })
})
