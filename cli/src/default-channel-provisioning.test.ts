// Verify startup default channels require local self-hosted guild configuration.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { setDataDir } from './config.js'
import { closeDb } from './db.js'
import { findChannelsByDirectory, initDatabase, setChannelDirectory } from './database.js'
import { createProjectChannels } from './channel-management.js'
import { ensureDefaultChannelsWithWelcome } from './cli-runner.js'
import { registerInteractionHandler } from './interaction-handler.js'

const trustedGuildId = '100000000000000111'
const otherGuildId = '100000000000000222'
const projectChannelId = '100000000000000333'
let directory: string
let discord: DigitalDiscord
let client: Client

beforeEach(async () => {
  const root = path.resolve('tmp/default-channel-provisioning')
  fs.mkdirSync(root, { recursive: true })
  directory = fs.mkdtempSync(path.join(root, 'run-'))
  setDataDir(directory)
  await closeDb()
  await initDatabase()
  discord = new DigitalDiscord({
    dbUrl: `file:${path.join(directory, 'discord.db')}`,
    users: [{ id: '100000000000000555', username: 'server-owner' }],
    guilds: [
      { id: trustedGuildId, name: 'Configured', ownerId: '100000000000000555', channels: [
        { id: projectChannelId, name: 'project', type: ChannelType.GuildText },
      ] },
      { id: otherGuildId, name: 'Unconfigured', ownerId: '100000000000000555', channels: [
        { name: 'project', type: ChannelType.GuildText, topic: directory },
      ] },
    ],
  })
  await discord.start()
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: { api: discord.restUrl, version: '10' },
  })
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()))
  await client.login(discord.botToken)
  await ready
})

afterEach(async () => {
  await client?.destroy()
  await discord?.stop()
  await closeDb()
  fs.rmSync(directory, { recursive: true, force: true })
})

test('self-hosted startup does not configure any guild without a live local mapping', async () => {
  await setChannelDirectory({
    channelId: '100000000000000444',
    directory,
    channelType: 'text',
    guildId: otherGuildId,
  })
  const before = await findChannelsByDirectory({})
  const created = await ensureDefaultChannelsWithWelcome({
    guilds: [...client.guilds.cache.values()], discordClient: client,
    appId: discord.botUserId, isGatewayMode: false,
  })
  expect(created).toEqual([])
  expect(await findChannelsByDirectory({})).toEqual(before)
  for (const guild of client.guilds.cache.values()) {
    expect((await guild.channels.fetch()).size).toBe(1)
  }
})

test('setup commands require a local channel mapping even for the server owner', async () => {
  registerInteractionHandler({ discordClient: client, appId: discord.botUserId })
  const channel = discord.channel(projectChannelId)
  // An invalid project name keeps the regression safe even when the guard fails.
  const options = [{ name: 'name', type: 3, value: '---' }]
  const ignored = await channel.user('100000000000000555').runSlashCommand({
    name: 'create-new-project', options,
  })
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await channel.getInteractionResponse(ignored.id))?.acknowledged ?? false).toBe(false)
  }
  expect(await findChannelsByDirectory({})).toEqual([])

  await setChannelDirectory({ channelId: projectChannelId, directory, channelType: 'text' })
  const allowed = await channel.user('100000000000000555').runSlashCommand({
    name: 'create-new-project', options,
  })
  await channel.waitForInteractionAck({ interactionId: allowed.id })
  await channel.waitForBotReply()
  expect(await channel.text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Invalid project name"
  `)
})

for (const setup of ['legacy mapping', 'explicit onboarding']) {
  test(`self-hosted startup provisions only the configured guild after ${setup}`, async () => {
    const guild = client.guilds.cache.get(trustedGuildId)!
    if (setup === 'legacy mapping') {
      await setChannelDirectory({ channelId: projectChannelId, directory, channelType: 'text' })
    } else {
      await createProjectChannels({ guild, projectDirectory: path.join(directory, 'project'), analyticsSource: 'onboarding' })
    }
    expect((await findChannelsByDirectory({}))[0]?.guild_id).toBeNull()
    // Fetching actual guild channels must work even when startup cache is empty.
    guild.channels.cache.clear()
    const created = await ensureDefaultChannelsWithWelcome({
      guilds: [...client.guilds.cache.values()], discordClient: client,
      appId: discord.botUserId, isGatewayMode: false,
    })
    for (const channel of created) {
      expect(await discord.channel(channel.id).text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        **Kimaki** lets you code from Discord. Send a message in any project channel and an AI agent edits code, runs commands, and searches your codebase — all on your machine.
        **What you can do:**
        - Use \`/add-project\` to create a Discord channel linked to one OpenCode project (git repo)
        - Collaborate with teammates in the same session
        - Upload images and files, the bot can share screenshots back
        Want to build an example browser game? Respond in this thread."
      `)
    }
    expect(created.map((channel) => channel.guildId)).toEqual([trustedGuildId])
    expect((await client.guilds.cache.get(otherGuildId)!.channels.fetch()).size).toBe(1)
    expect(await ensureDefaultChannelsWithWelcome({
      guilds: [...client.guilds.cache.values()], discordClient: client,
      appId: discord.botUserId, isGatewayMode: false,
    })).toEqual([])
  })
}

test('gateway startup provisions every proxy-authorized guild without local mappings', async () => {
  const created = await ensureDefaultChannelsWithWelcome({
    guilds: [...client.guilds.cache.values()], discordClient: client,
    appId: discord.botUserId, isGatewayMode: true,
  })
  for (const channel of created) {
    expect(await discord.channel(channel.id).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      **Kimaki** lets you code from Discord. Send a message in any project channel and an AI agent edits code, runs commands, and searches your codebase — all on your machine.
      **What you can do:**
      - Use \`/add-project\` to create a Discord channel linked to one OpenCode project (git repo)
      - Collaborate with teammates in the same session
      - Upload images and files, the bot can share screenshots back
      Want to build an example browser game? Respond in this thread."
    `)
  }
  expect(created.map((channel) => channel.guildId).sort()).toEqual([trustedGuildId, otherGuildId])
  expect(await findChannelsByDirectory({})).toHaveLength(2)
})
