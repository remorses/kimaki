// Regression tests for CLI argument parsing around Discord ID string preservation.
import { describe, expect, test } from 'vitest'
import { execAsync } from './exec-async.js'

async function parseWithGoke(argv: string[]) {
  const script = [
    "import { goke } from 'goke'",
    'const cli = goke(\'kimaki\')',
    "cli.command('send', 'Send a message').option('-c, --channel <channelId>', 'Discord channel ID').option('--thread <threadId>', 'Thread ID').option('--session <sessionId>', 'Session ID').option('--send-at <schedule>', 'Schedule')",
    "cli.command('session archive <threadId>', 'Archive a thread')",
    "cli.command('session search <query>', 'Search sessions').option('--channel <channelId>', 'Discord channel ID').option('--project <path>', 'Project path')",
    "cli.command('session export-events-jsonl', 'Export in-memory events to JSONL').option('--session <sessionId>', 'Session ID').option('--out <file>', 'Output path')",
    "cli.command('add-project', 'Add a project').option('-g, --guild <guildId>', 'Discord guild/server ID')",
    "cli.command('task delete <id>', 'Delete task')",
    "cli.command('anthropic-accounts list', 'List stored Anthropic accounts')",
    "cli.command('anthropic-accounts remove <indexOrEmail>', 'Remove stored Anthropic account')",
    `const result = cli.parse(${JSON.stringify(argv)}, { run: false })`,
    'process.stdout.write(JSON.stringify({ args: result.args, options: result.options }))',
  ].join(';')

  const { stdout } = await execAsync(`node --input-type=module -e ${JSON.stringify(script)}`, {
    cwd: import.meta.dirname,
    timeout: 10_000,
  })
  return JSON.parse(stdout) as {
    args: string[]
    options: Record<string, string>
  }
}

async function getHelpOutput() {
  const script = [
    "import { goke } from 'goke'",
    'const stdout = { text: \'\', write(data) { this.text += String(data) } }',
    "const cli = goke('kimaki', { stdout })",
    "cli.command('send', 'Send a message')",
    "cli.command('anthropic-accounts list', 'List stored Anthropic accounts')",
    'cli.help()',
    "cli.parse(['node', 'kimaki', '--help'], { run: false })",
    'process.stdout.write(stdout.text)',
  ].join(';')

  const { stdout } = await execAsync(`node --input-type=module -e ${JSON.stringify(script)}`, {
    cwd: import.meta.dirname,
    timeout: 10_000,
  })
  return stdout
}

describe('goke CLI ID parsing', () => {
  test('keeps large Discord IDs as strings', async () => {
    const channelId = '1234567890123456789'
    const threadId = '9876543210987654321'
    const sessionId = '1111222233334444555'

    const channelResult = await parseWithGoke(
      ['node', 'kimaki', 'send', '--channel', channelId],
    )
    expect(channelResult.options.channel).toBe(channelId)
    expect(typeof channelResult.options.channel).toBe('string')

    const threadResult = await parseWithGoke(
      ['node', 'kimaki', 'send', '--thread', threadId],
    )
    expect(threadResult.options.thread).toBe(threadId)
    expect(typeof threadResult.options.thread).toBe('string')

    const sessionResult = await parseWithGoke(
      ['node', 'kimaki', 'send', '--session', sessionId],
    )
    expect(sessionResult.options.session).toBe(sessionId)
    expect(typeof sessionResult.options.session).toBe('string')
  })

  test('preserves leading zeros in Discord IDs', async () => {
    const guildId = '001230045600789'

    const result = await parseWithGoke(
      ['node', 'kimaki', 'add-project', '--guild', guildId],
    )

    expect(result.options.guild).toBe(guildId)
    expect(typeof result.options.guild).toBe('string')
  })

  test('keeps session archive thread ID as string', async () => {
    const threadId = '0098765432109876543'

    const result = await parseWithGoke(
      ['node', 'kimaki', 'session', 'archive', threadId],
    )

    expect(result.args[0]).toBe(threadId)
    expect(typeof result.args[0]).toBe('string')
  })

  test('keeps session search regex and channel ID as strings', async () => {
    const channelId = '0012345678901234567'
    const query = '/error\\s+42/i'

    const result = await parseWithGoke(
      ['node', 'kimaki', 'session', 'search', query, '--channel', channelId],
    )

    expect(result.args[0]).toBe(query)
    expect(typeof result.args[0]).toBe('string')
    expect(result.options.channel).toBe(channelId)
    expect(typeof result.options.channel).toBe('string')
  })

  test('keeps session export options as strings', async () => {
    const sessionId = '001111222233334444'
    const outPath = './tmp/session-events.jsonl'

    const result = await parseWithGoke(
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
    )

    expect(result.options.session).toBe(sessionId)
    expect(typeof result.options.session).toBe('string')
    expect(result.options.out).toBe(outPath)
    expect(typeof result.options.out).toBe('string')
  })

  test('keeps --send-at cron string intact', async () => {
    const cron = '0 9 * * 1'

    const result = await parseWithGoke(['node', 'kimaki', 'send', '--send-at', cron])

    expect(result.options.sendAt).toBe(cron)
    expect(typeof result.options.sendAt).toBe('string')
  })

  test('keeps task delete ID as string before validation', async () => {
    const taskId = '0012345'

    const result = await parseWithGoke(['node', 'kimaki', 'task', 'delete', taskId])

    expect(result.args[0]).toBe(taskId)
    expect(typeof result.args[0]).toBe('string')
  })

  test('anthropic account remove parses index and email as strings', async () => {
    const indexResult = await parseWithGoke(
      ['node', 'kimaki', 'anthropic-accounts', 'remove', '2'],
    )

    const emailResult = await parseWithGoke(
      ['node', 'kimaki', 'anthropic-accounts', 'remove', 'user@example.com'],
    )

    expect(indexResult.args[0]).toBe('2')
    expect(typeof indexResult.args[0]).toBe('string')
    expect(emailResult.args[0]).toBe('user@example.com')
    expect(typeof emailResult.args[0]).toBe('string')
  })

  test('anthropic account commands are included in help output', async () => {
    const stdout = await getHelpOutput()

    expect(stdout).toContain('send')
    expect(stdout).toContain('anthropic-accounts')
  })
})
