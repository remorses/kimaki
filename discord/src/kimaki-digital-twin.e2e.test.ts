// End-to-end test using discord-digital-twin + real Kimaki bot runtime.
// Verifies onboarding channel creation, message -> thread creation, and assistant reply.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { expect, test } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { CachedOpencodeProviderProxy } from 'opencode-cached-provider'
import { setDataDir } from './config.js'
import { startDiscordBot } from './discord-bot.js'
import {
  setBotToken,
  initDatabase,
  closeDatabase,
  setChannelDirectory,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { cleanupOpencodeServers, cleanupTestSessions } from './test-utils.js'

const geminiApiKey =
  process.env['GEMINI_API_KEY'] ||
  process.env['GOOGLE_GENERATIVE_AI_API_KEY'] ||
  ''
const geminiModel = process.env['GEMINI_FLASH_MODEL'] || 'gemini-2.5-flash'
const e2eTest = geminiApiKey.length > 0 ? test : test.skip

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'kimaki-digital-twin-e2e')
  fs.mkdirSync(root, { recursive: true })

  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  const providerCacheDbPath = path.join(root, 'provider-cache.db')
  fs.mkdirSync(projectDirectory, { recursive: true })

  return {
    root,
    dataDir,
    projectDirectory,
    providerCacheDbPath,
  }
}

function chooseLockPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to resolve lock port'))
        return
      }
      const port = address.port
      server.close(() => {
        resolve(port)
      })
    })
  })
}

function createDiscordJsClient({ restUrl }: { restUrl: string }) {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.ThreadMember,
    ],
    rest: {
      api: restUrl,
      version: '10',
    },
  })
}

e2eTest(
  'onboarding then message creates thread and assistant reply via digital twin',
  async () => {
    const testStartTime = Date.now()
    const directories = createRunDirectories()
    const lockPort = await chooseLockPort()

    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    setDataDir(directories.dataDir)

    const proxy = new CachedOpencodeProviderProxy({
      cacheDbPath: directories.providerCacheDbPath,
      targetBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: geminiApiKey,
      cacheMethods: ['POST'],
    })

    const testUserId = '100000000000000777'
    const textChannelId = '100000000000000778'
    const digitalDiscordDbPath = path.join(
      directories.dataDir,
      'digital-discord.db',
    )
    const discord = new DigitalDiscord({
      guild: {
        name: 'Kimaki E2E Guild',
        ownerId: testUserId,
      },
      channels: [
        {
          id: textChannelId,
          name: 'kimaki-e2e',
          type: ChannelType.GuildText,
        },
      ],
      users: [
        {
          id: testUserId,
          username: 'e2e-user',
        },
      ],
      dbUrl: `file:${digitalDiscordDbPath}`,
    })

    let botClient: Client | null = null

    try {
      await Promise.all([proxy.start(), discord.start()])

      const opencodeConfig = proxy.buildOpencodeConfig({
        providerName: 'cached-google',
        providerNpm: '@ai-sdk/google',
        model: geminiModel,
        smallModel: geminiModel,
      })
      fs.writeFileSync(
        path.join(directories.projectDirectory, 'opencode.json'),
        JSON.stringify(opencodeConfig, null, 2),
      )

      const dbPath = path.join(directories.dataDir, 'discord-sessions.db')
      const hranaResult = await startHranaServer({ dbPath })
      if (hranaResult instanceof Error) {
        throw hranaResult
      }
      process.env['KIMAKI_DB_URL'] = hranaResult
      await initDatabase()
      await setBotToken(discord.botUserId, discord.botToken)

      await setChannelDirectory({
        channelId: textChannelId,
        directory: directories.projectDirectory,
        channelType: 'text',
      })

      botClient = createDiscordJsClient({ restUrl: discord.restUrl })
      await startDiscordBot({
        token: discord.botToken,
        appId: discord.botUserId,
        discordClient: botClient,
      })

      await discord.channel(textChannelId).user(testUserId).sendMessage({
        content: 'Reply with exactly: kimaki digital twin ok',
      })

      const createdThread = await discord.channel(textChannelId).waitForThread({
        timeout: 60_000,
        predicate: (thread) => {
          return thread.name === 'Reply with exactly: kimaki digital twin ok'
        },
      })

      const botReply = await discord.thread(createdThread.id).waitForBotReply({
        timeout: 120_000,
      })

      expect(createdThread.id.length).toBeGreaterThan(0)
      expect(botReply.content.trim().length).toBeGreaterThan(0)
    } finally {
      await cleanupTestSessions({
        projectDirectory: directories.projectDirectory,
        testStartTime,
      })

      if (botClient) {
        botClient.destroy()
      }

      await cleanupOpencodeServers()
      await Promise.all([
        closeDatabase().catch(() => {
          return
        }),
        stopHranaServer().catch(() => {
          return
        }),
        proxy.stop().catch(() => {
          return
        }),
        discord.stop().catch(() => {
          return
        }),
      ])

      delete process.env['KIMAKI_LOCK_PORT']
      delete process.env['KIMAKI_DB_URL']
      fs.rmSync(directories.dataDir, { recursive: true, force: true })
    }
  },
  360_000,
)
