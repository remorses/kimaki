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

  cli.command('session archive <threadId>', 'Archive a thread')

  cli
    .command('add-project', 'Add a project')
    .option('-g, --guild <guildId>', 'Discord guild/server ID')

  return cli
}

describe('goke CLI ID parsing', () => {
  test('keeps large Discord IDs as strings', () => {
    const cli = createCliForIdParsing()
    const channelId = '1234567890123456789'
    const threadId = '9876543210987654321'
    const sessionId = '1111222233334444555'

    const channelResult = cli.parse(['node', 'kimaki', 'send', '--channel', channelId], {
      run: false,
    })
    expect(channelResult.options.channel).toBe(channelId)
    expect(typeof channelResult.options.channel).toBe('string')

    const threadResult = cli.parse(['node', 'kimaki', 'send', '--thread', threadId], { run: false })
    expect(threadResult.options.thread).toBe(threadId)
    expect(typeof threadResult.options.thread).toBe('string')

    const sessionResult = cli.parse(['node', 'kimaki', 'send', '--session', sessionId], {
      run: false,
    })
    expect(sessionResult.options.session).toBe(sessionId)
    expect(typeof sessionResult.options.session).toBe('string')
  })

  test('preserves leading zeros in Discord IDs', () => {
    const cli = createCliForIdParsing()
    const guildId = '001230045600789'

    const result = cli.parse(['node', 'kimaki', 'add-project', '--guild', guildId], { run: false })

    expect(result.options.guild).toBe(guildId)
    expect(typeof result.options.guild).toBe('string')
  })

  test('keeps session archive thread ID as string', () => {
    const cli = createCliForIdParsing()
    const threadId = '0098765432109876543'

    const result = cli.parse(['node', 'kimaki', 'session', 'archive', threadId], {
      run: false,
    })

    expect(result.args[0]).toBe(threadId)
    expect(typeof result.args[0]).toBe('string')
  })
})
