import fs from 'node:fs'
import { ComponentType } from 'discord.js'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { BotHandle } from './main.ts'
import { TEST_USER_ID, seedProjectChannel, startOpencodeTestServer, startTestBot, startTwin, tempDataDir, waitFor, waitForFooter, warmUp, toolParts, textParts, type OpencodeTestServer, type TestTwin } from './test/harness.ts'

const dataDir = tempDataDir()
let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
beforeAll(async () => {
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers: [
    { id: 'buttons', priority: 100, when: { latestUserTextIncludes: 'button-marker' }, then: { parts: [
      { type: 'text-start', id: 'intro' }, { type: 'text-delta', id: 'intro', delta: 'Choose the next action.' }, { type: 'text-end', id: 'intro' },
      ...toolParts({ toolCallId: 'buttons-call', toolName: 'shell', input: { command: "kimaki buttons --button 'Proceed' --button 'Build=printf built:green'", description: 'Show choices', hasSideEffect: true } }),
    ] } },
    { id: 'buttons-done', priority: 110, when: { latestUserTextIncludes: 'button-marker', rawPromptIncludes: 'buttons-call' }, then: { parts: textParts('Buttons shown.') } },
    { id: 'click', priority: 200, when: { latestUserTextIncludes: 'User clicked: Proceed' }, then: { parts: textParts('Proceed accepted.') } },
    { id: 'upload', priority: 100, when: { latestUserTextIncludes: 'upload-marker' }, then: { parts: toolParts({ toolCallId: 'upload-call', toolName: 'shell', input: { command: "kimaki upload-request --prompt 'Send the logo' --max-files 2", timeout: 600000, description: 'Request logo', hasSideEffect: true } }) } },
    { id: 'upload-done', priority: 110, when: { latestUserTextIncludes: 'upload-marker', rawPromptIncludes: 'upload-call' }, then: { parts: textParts('Upload received.') } },
    { id: 'branch', priority: 200, when: { latestUserTextIncludes: 'git-marker', rawPromptIncludes: '[current git branch is main]' }, then: { parts: textParts('Git context received.') } },
  ] }), startTwin()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({ dataDir, twin, server })
  await warmUp({ server })
}, 60_000)
afterAll(async () => {
  await bot?.stop()
  await Promise.all([server?.stop(), twin?.stop()])
  fs.rmSync(dataDir, { recursive: true, force: true })
})
async function start(prompt: string) {
  const result = await bot.actions.send({ channelId: twin.channelId, prompt })
  if (result instanceof Error) throw result
  return result.threadId
}
async function ui(threadId: string, prefix: string) {
  return waitFor({ label: prefix, check: async () => {
    for (const message of await twin.discord.thread(threadId).getMessages()) for (const row of message.components ?? []) {
      if (row.type !== ComponentType.ActionRow) continue
      for (const item of row.components) if (item.type === ComponentType.Button && 'custom_id' in item && item.custom_id.startsWith(prefix)) return { message, button: item }
    }
    return null
  } })
}
test('agent shim shows buttons after text and a click resumes the real session', async () => {
  const threadId = await start('button-marker')
  const shown = await ui(threadId, 'action_button:')
  await waitForFooter({ discord: twin.discord, threadId })
  const sessionId = bot.store.getState().roots[threadId]!
  const shell = bot.actions.shell({ threadId, sessionId, command: 'printf synthetic' })
  if (shell instanceof Error) throw shell
  await waitFor({ label: 'synthetic shell output', check: async () => (await twin.discord.thread(threadId).text()).includes('```\nsynthetic\n```') })
  await twin.discord.thread(threadId).user(TEST_USER_ID).clickButton({ messageId: shown.message.id, customId: shown.button.custom_id })
  await waitForFooter({ discord: twin.discord, threadId, count: 2 })
  expect(await twin.discord.thread(threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** button-marker
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Choose the next action.

    -# ┣ shell _Show choices_
    Dismissed

    Buttons shown.
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    -# $ printf synthetic
    \`\`\`
    synthetic
    \`\`\`

    Proceed accepted.
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const messages = await twin.discord.thread(threadId).getMessages()
  expect(messages.findIndex((message) => message.content.includes('Choose the next action.'))).toBeLessThan(messages.findIndex((message) => message.id === shown.message.id))
  expect(messages.some((message) => message.content.includes('Proceed accepted.'))).toBe(true)
})
test('native file upload modal returns local paths to the agent shell', async () => {
  const threadId = await start('upload-marker')
  const shown = await ui(threadId, 'file_upload_btn:')
  const user = twin.discord.thread(threadId).user(TEST_USER_ID)
  const clicked = await user.clickButton({ messageId: shown.message.id, customId: shown.button.custom_id })
  await twin.discord.thread(threadId).waitForInteractionAck({ interactionId: clicked.id })
  await user.submitModal({ customId: shown.button.custom_id.replace('file_upload_btn:', 'file_upload_modal:'), fields: [], files: [{ customId: 'files', attachments: [{
    id: '200000000000009999', filename: 'logo.txt', size: 4, url: 'data:text/plain;base64,bG9nbw==', proxy_url: 'data:text/plain;base64,bG9nbw==',
  }] }] })
  await waitForFooter({ discord: twin.discord, threadId })
  expect(await twin.discord.thread(threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** upload-marker
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ┣ shell _Request logo_
    Dismissed
    Uploaded 1 file(s)

    Upload received.
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const dirs = fs.readdirSync(`${server.projectDirectory}/uploads`)
  expect(fs.readFileSync(`${server.projectDirectory}/uploads/${dirs[0]}/0-logo.txt`, 'utf8')).toBe('logo')
})
test('git context is added only to marked Discord sessions', async () => {
  const threadId = await start('git-marker')
  await waitForFooter({ discord: twin.discord, threadId })
  expect(await twin.discord.thread(threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** git-marker
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Git context received.
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect((await twin.discord.thread(threadId).text()).includes('Git context received.')).toBe(true)
  const client = await server.client()
  const plugins = await client.plugin.list({ location: { directory: server.projectDirectory } })
  expect(plugins.data.find((plugin) => plugin.id === 'kimaki')?.state.status).toBe('active')
  const session = await client.session.create({ location: { directory: server.projectDirectory } })
  await client.session.prompt({ sessionID: session.id, text: 'git-marker' })
  await client.session.wait({ sessionID: session.id })
  expect(JSON.stringify(await client.message.list({ sessionID: session.id }))).not.toContain('Git context received.')
})
