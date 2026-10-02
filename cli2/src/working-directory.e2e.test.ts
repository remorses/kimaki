import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ComponentType } from 'discord.js'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { git } from './worktrees.ts'
import { TEST_USER_ID, scriptedTurn, seedProjectChannel, slowTextMatcher, startOpencodeTestServer, startTestBot, startTwin, tempDataDir, waitForBotMessageContaining, waitForFooter, warmUp, type OpencodeTestServer, type TestTwin } from './test/harness.ts'
import { manageWorktree, newWorktree, setAutoWorktrees } from './commands/worktree-commands.ts'
import { runLockRoute } from './lock-routes.ts'
import { send } from './prompt.ts'
import { forkBtw } from './sessions.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers: [
    ...scriptedTurn({ marker: 'write-cwd-marker', steps: [{ id: 'execute-location-tool', tool: 'shell', input: { command: 'printf isolated > cwd.txt', description: 'Write to the current directory', hasSideEffect: true } }], finalText: 'Wrote cwd.txt.' }),
    slowTextMatcher({ marker: 'busy-move-marker', text: 'Finished without interruption.', delayMs: 500 }),
  ] }), startTwin()])
  fs.mkdirSync(path.join(server.projectDirectory, 'sub'))
  fs.writeFileSync(path.join(server.projectDirectory, 'tracked.txt'), 'original\n')
  for (const args of [['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.com'], ['add', '.'], ['commit', '-qm', 'initial']]) {
    const result = await git({ directory: server.projectDirectory, args })
    if (result instanceof Error) throw result
  }
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function hide(text: string) {
  return text.replaceAll(server.projectDirectory, 'PROJECT').replaceAll(dataDir, 'DATA').replace(/worktrees\/[a-f0-9]{8}/g, 'worktrees/HASH').replace(/<#\d+>/g, '<#THREAD>')
}

test('session cwd changes preserve the session and use the new location after restart and btw', async () => {
  const sent = await send(bot, { channelId: twin.channelId, prompt: 'Start cwd session', name: 'cwd-test' })
  if (sent instanceof Error || !sent.sessionId) throw sent
  await waitForFooter({ discord: twin.discord, threadId: sent.threadId })
  const moved = await runLockRoute(bot, { route: 'session.cwd', input: { sessionId: sent.sessionId, directory: 'sub' }, signal: new AbortController().signal })
  if (moved instanceof Error) throw moved
  const client = await server.client()
  await client.session.wait({ sessionID: sent.sessionId })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: sent.threadId, text: 'Working directory changed' })
  await bot.stop()
  bot = await startTestBot({ dataDir, twin, server })
  await twin.discord.thread(sent.threadId).user(TEST_USER_ID).sendMessage({ content: 'write-cwd-marker' })
  await waitForFooter({ discord: twin.discord, threadId: sent.threadId, count: 2 })
  expect(hide(await twin.discord.thread(sent.threadId).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** Start cwd session
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    -# Working directory changed to PROJECT/sub
    --- from: user (tommy)
    write-cwd-marker
    --- from: assistant (TestBot)
    -# ┣ shell _Write to the current directory_

    Wrote cwd.txt.
    -# *sub ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect((await client.session.get({ sessionID: sent.sessionId })).location.directory).toBe(path.join(server.projectDirectory, 'sub'))
  expect(fs.readFileSync(path.join(server.projectDirectory, 'sub', 'cwd.txt'), 'utf8')).toBe('isolated')
  expect(fs.existsSync(path.join(server.projectDirectory, 'cwd.txt'))).toBe(false)
  const source = await bot.discord.channels.fetch(sent.threadId)
  if (!source?.isThread()) throw new Error('No thread')
  const fork = await forkBtw(bot, { sourceThread: source, text: 'Side question', author: { id: TEST_USER_ID, username: 'tommy' }, messageId: 'cwd-btw' })
  if (fork instanceof Error) throw fork
  await waitForFooter({ discord: twin.discord, threadId: fork.threadId })
  expect(hide(await twin.discord.thread(fork.threadId).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Reusing context from <#THREAD> to answer prompt...
    Side question
    ok
    -# *sub ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect((await client.session.get({ sessionID: fork.sessionId })).location.directory).toBe(path.join(server.projectDirectory, 'sub'))
})

test('native moves of a busy session update the live footer without aborting its response', async () => {
  const sent = await send(bot, { channelId: twin.channelId, prompt: 'busy-move-marker' })
  if (sent instanceof Error || !sent.sessionId) throw sent
  await waitForBotMessageContaining({ discord: twin.discord, threadId: sent.threadId, text: '*using ' })
  const client = await server.client()
  await client.session.move({ sessionID: sent.sessionId, directory: path.join(server.projectDirectory, 'sub') })
  await client.session.wait({ sessionID: sent.sessionId })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: sent.threadId, text: 'Working directory changed' })
  await twin.discord.thread(sent.threadId).user(TEST_USER_ID).runSlashCommand({ name: 'cwd' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: sent.threadId, text: 'Working directory:' })
  await waitForFooter({ discord: twin.discord, threadId: sent.threadId })
  expect(hide(await twin.discord.thread(sent.threadId).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** busy-move-marker
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Finished without interruption.
    -# Working directory changed to PROJECT/sub
    -# *sub ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    Working directory: \`PROJECT/sub\`"
  `)
  expect((await client.session.get({ sessionID: sent.sessionId })).location.directory).toBe(path.join(server.projectDirectory, 'sub'))
})

test('new-worktree forks context, and CLI creation and worktree toggle use the same directory policy', async () => {
  const client = await server.client()
  const source = await send(bot, { channelId: twin.channelId, prompt: 'Remember fork context' })
  if (source instanceof Error || !source.sessionId) throw source
  await waitForFooter({ discord: twin.discord, threadId: source.threadId })
  const before = new Set((await twin.discord.channel(twin.channelId).getThreads()).map((thread) => thread.id))
  await twin.discord.thread(source.threadId).user(TEST_USER_ID).runSlashCommand({ name: 'new-worktree', options: [{ name: 'name', type: 3, value: 'forked-checkout' }] })
  const fork = await twin.discord.channel(twin.channelId).waitForThread({ predicate: (thread) => !before.has(thread.id) })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: fork.id, text: 'continue the conversation' })
  expect(hide(await twin.discord.thread(fork.id).text()).replace(/ses_\w+/g, 'ses_ID')).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    **Forked session created!**
    From: <#THREAD> (\`ses_ID\`)
    New session: \`ses_ID\`
    ok
    You can now continue the conversation from this point."
  `)
  const forkInfo = await client.session.get({ sessionID: bot.store.getState().roots[fork.id]! })
  expect(forkInfo.location.directory).toContain('forked-checkout')
  expect((await client.session.get({ sessionID: source.sessionId })).location.directory).toBe(server.projectDirectory)
  expect((await client.message.list({ sessionID: forkInfo.id })).data.some((message) => message.type === 'user' && message.text.includes('Remember fork context'))).toBe(true)
  const choices = await twin.discord.channel(twin.channelId).user(TEST_USER_ID).autocomplete({ name: 'resume', options: [{ name: 'session', type: 3, value: 'Remember fork context' }], focused: 'session' })
  expect(choices.some((choice) => choice.value === forkInfo.id)).toBe(true)
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'send', '--channel', twin.channelId, '--worktree', 'cli-checkout', '--prompt', 'CLI isolation', '--data-dir', dataDir], { env: { ...process.env, KIMAKI_LOCK_PORT: String(bot.lock.port) } })
  const created = JSON.parse(result.stdout) as { threadId: string; sessionId: string }
  await waitForFooter({ discord: twin.discord, threadId: created.threadId })
  expect(hide(await twin.discord.thread(created.threadId).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** CLI isolation
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *cli-checkout ⋅ opencode/kimaki-cli-checkout ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect((await client.session.get({ sessionID: created.sessionId })).location.directory).toContain('cli-checkout')
  const enabled = await setAutoWorktrees(bot, { channelId: twin.channelId, enabled: true })
  if (enabled instanceof Error) throw enabled
  const automatic = await send(bot, { channelId: twin.channelId, prompt: 'Automatic isolation' })
  if (automatic instanceof Error || !automatic.sessionId) throw automatic
  await waitForFooter({ discord: twin.discord, threadId: automatic.threadId })
  expect(hide(await twin.discord.thread(automatic.threadId).text()).replace(/automatic-isolation-[a-f0-9]{8}/g, 'automatic-isolation-ID')).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** Automatic isolation
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *automatic-isolation-ID ⋅ opencode/kimaki-automatic-isolation-ID ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect((await client.session.get({ sessionID: automatic.sessionId })).location.directory).not.toBe(server.projectDirectory)
  const disabled = await setAutoWorktrees(bot, { channelId: twin.channelId, enabled: false })
  if (disabled instanceof Error) throw disabled
})

test('send worktree creates an isolated named checkout, while explicit cwd reuses it', async () => {
  const sent = await send(bot, { channelId: twin.channelId, prompt: 'write-cwd-marker', worktree: 'isolated', name: 'isolated-test' })
  if (sent instanceof Error || !sent.sessionId) throw sent
  await waitForFooter({ discord: twin.discord, threadId: sent.threadId })
  expect(hide(await twin.discord.thread(sent.threadId).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** write-cwd-marker
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ┣ shell _Write to the current directory_

    Wrote cwd.txt.
    -# *isolated ⋅ opencode/kimaki-isolated ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const client = await server.client()
  const info = await client.session.get({ sessionID: sent.sessionId })
  expect(info.location.directory).not.toBe(server.projectDirectory)
  expect(fs.readFileSync(path.join(info.location.directory, 'cwd.txt'), 'utf8')).toBe('isolated')
  expect(fs.existsSync(path.join(server.projectDirectory, 'cwd.txt'))).toBe(false)
  const reused = await send(bot, { channelId: twin.channelId, prompt: 'Reuse checkout', cwd: info.location.directory })
  if (reused instanceof Error || !reused.sessionId) throw reused
  await waitForFooter({ discord: twin.discord, threadId: reused.threadId })
  expect(hide(await twin.discord.thread(reused.threadId).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** Reuse checkout
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *isolated ⋅ opencode/kimaki-isolated ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect((await client.session.get({ sessionID: reused.sessionId })).location.directory).toBe(info.location.directory)
})

test('worktree delete buttons recheck dirty state instead of trusting the displayed list', async () => {
  const created = await newWorktree(bot, { channelId: twin.channelId, name: 'aaa-delete', author: { id: TEST_USER_ID, username: 'tommy' } })
  if (created instanceof Error) throw created
  await waitForBotMessageContaining({ discord: twin.discord, threadId: created.threadId, text: 'Worktree ready' })
  const user = twin.discord.thread(created.threadId).user(TEST_USER_ID)
  await user.runSlashCommand({ name: 'worktrees' })
  const displayed = await waitForBotMessageContaining({ discord: twin.discord, threadId: created.threadId, text: '**Worktrees**' })
  const row = displayed.components?.find((component) => component.type === ComponentType.ActionRow)
  const button = row?.type === ComponentType.ActionRow ? row.components.find((component) => component.type === ComponentType.Button && 'label' in component && component.label === 'Delete 1') : null
  if (button?.type !== ComponentType.Button || !('custom_id' in button)) throw new Error('No delete button')
  const directory = (await (await server.client()).session.get({ sessionID: created.sessionId })).location.directory
  fs.writeFileSync(path.join(directory, 'unsaved.txt'), 'Do not delete\n')
  await user.clickButton({ messageId: displayed.id, customId: button.custom_id })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: created.threadId, text: 'Uncommitted changes' })
  expect(hide(await twin.discord.thread(created.threadId).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Worktree ready: \`DATA/worktrees/HASH/aaa-delete\`
    Branch: \`opencode/kimaki-aaa-delete\`
    Send a message to start working.
    Uncommitted changes in DATA/worktrees/HASH/aaa-delete. Commit or discard them first."
  `)
  expect(fs.readFileSync(path.join(directory, 'unsaved.txt'), 'utf8')).toBe('Do not delete\n')
  fs.unlinkSync(path.join(directory, 'unsaved.txt'))
  const removed = await manageWorktree(bot, { channelId: twin.channelId, directory, operation: 'remove' })
  if (removed instanceof Error) throw removed
  expect(fs.existsSync(directory)).toBe(false)
})
