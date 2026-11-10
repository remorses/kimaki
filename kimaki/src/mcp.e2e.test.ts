// /mcp end to end: the MCP table in a channel and in a session thread, and its
// Disconnect / Connect buttons against a real stdio MCP server (test/fake-mcp-server.ts).

import fs from 'node:fs'
import path from 'node:path'
import { ComponentType, type APIMessage } from 'discord.js'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { getMessageVisibleText } from 'discord-digital-twin/src'
import type { BotHandle } from './main.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  waitFor,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
const dataDir = tempDataDir()

beforeAll(async () => {
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({
      mcp: {
        servers: {
          fake: { type: 'local', command: [process.execPath, path.join(import.meta.dirname, 'test', 'fake-mcp-server.ts')] },
          broken: { type: 'local', command: [process.execPath, '-e', 'process.exit(1)'] },
        },
      },
    }),
    startTwin(),
  ])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({ dataDir, twin, server })
  await warmUp({ server })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await Promise.all([server?.stop(), twin?.stop()])
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// Buttons of action rows and of Section accessories.
function buttons(message: APIMessage) {
  const found: Array<{ label: string; customId: string; disabled: boolean }> = []
  const walk = (components: readonly unknown[]) => {
    for (const component of components) {
      if (!component || typeof component !== 'object') continue
      if ('type' in component && component.type === ComponentType.Button && 'custom_id' in component && typeof component.custom_id === 'string') {
        found.push({ label: 'label' in component ? String(component.label) : '', customId: component.custom_id, disabled: 'disabled' in component && component.disabled === true })
      }
      if ('accessory' in component) walk([component.accessory])
      if ('components' in component && Array.isArray(component.components)) walk(component.components)
    }
  }
  walk(message.components ?? [])
  return found
}

async function mcpStatus(name: string) {
  const listed = await (await server.client()).mcp.list({ location: { directory: server.projectDirectory } })
  return listed.data.find((entry) => entry.name === name)?.status.status
}

async function text(id: string) {
  return (await twin.discord.channel(id).text()).replaceAll(server.projectDirectory, '<project>')
}

// Runs /mcp in a channel or thread and returns its reply once both servers settled.
async function runMcp(channelId: string) {
  await waitFor({ label: 'MCP servers settled', check: async () => (await mcpStatus('fake')) === 'connected' && (await mcpStatus('broken')) === 'failed' })
  const { id } = await twin.discord.channel(channelId).user(TEST_USER_ID).runSlashCommand({ name: 'mcp' })
  await twin.discord.channel(channelId).waitForInteractionAck({ interactionId: id })
  return waitFor({
    label: '/mcp reply',
    check: async () => (await twin.discord.channel(channelId).getMessages()).find((message) => getMessageVisibleText(message).includes('MCP servers')),
  })
}

test('/mcp in a channel lists servers; Disconnect and Connect toggle one', async () => {
  const { discord, channelId } = twin
  const reply = await runMcp(channelId)
  expect(await text(channelId)).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    ### MCP servers
    -# \`<project>\`
    -# Changes last until OpenCode reloads this folder. opencode.json is not changed.
    ---
    **broken**
    -# Failed: Connection closed: MCP server process exited with code 1
    ---
    **fake**
    -# Connected"
  `)
  expect(buttons(reply)).toMatchInlineSnapshot(`
    [
      {
        "customId": "mcp:connect:f526795c95399cea",
        "disabled": false,
        "label": "Retry",
      },
      {
        "customId": "mcp:disconnect:b5d54c39e66671c9",
        "disabled": false,
        "label": "Disconnect",
      },
    ]
  `)

  const user = discord.channel(channelId).user(TEST_USER_ID)
  const disconnect = buttons(reply).find((entry) => entry.label === 'Disconnect')!
  await user.clickButton({ messageId: reply.id, customId: disconnect.customId })
  await waitFor({ label: 'fake disabled', check: async () => (await text(channelId)).includes('Disabled') })
  expect(await text(channelId)).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    ### MCP servers
    -# \`<project>\`
    -# Changes last until OpenCode reloads this folder. opencode.json is not changed.
    ---
    **broken**
    -# Failed: Connection closed: MCP server process exited with code 1
    ---
    **fake**
    -# Disabled"
  `)
  expect(await mcpStatus('fake')).toBe('disabled')

  const edited = (await discord.channel(channelId).getMessages()).find((message) => message.id === reply.id)!
  const connect = buttons(edited).find((entry) => entry.label === 'Connect')!
  await user.clickButton({ messageId: reply.id, customId: connect.customId })
  await waitFor({ label: 'fake connected', check: async () => (await text(channelId)).includes('**fake**\n-# Connected') })
  expect(await text(channelId)).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    ### MCP servers
    -# \`<project>\`
    -# Changes last until OpenCode reloads this folder. opencode.json is not changed.
    ---
    **broken**
    -# Failed: Connection closed: MCP server process exited with code 1
    ---
    **fake**
    -# Connected"
  `)
})

test('/mcp works in a session thread', async () => {
  const { discord, channelId } = twin
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'MCP thread' })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000 })
  await waitForFooter({ discord, threadId: thread.id })
  await runMcp(thread.id)
  expect(await text(thread.id)).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    MCP thread
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *main ⋅ Ns ⋅ deterministic-v2*
    ### MCP servers
    -# \`<project>\`
    -# Changes last until OpenCode reloads this folder. opencode.json is not changed.
    ---
    **broken**
    -# Failed: Connection closed: MCP server process exited with code 1
    ---
    **fake**
    -# Connected"
  `)
})
