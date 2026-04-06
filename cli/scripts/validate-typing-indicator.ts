#!/usr/bin/env tsx
// Script that probes Discord typing request lifetime in a real thread.

import { goke } from 'goke'
import { z } from 'zod'
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  ThreadAutoArchiveDuration,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import * as errore from 'errore'
import { createLogger } from '../src/logger.js'

const logger = createLogger('TYPECHK')

const DEFAULT_GUILD_ID = '1422625037164351591'
const DEFAULT_CHANNEL_ID = '1422625308523102348'
const DEFAULT_MESSAGE_DELAY_MS = 1_500
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_TOKEN_ENV = 'DISCORD_BOT_TOKEN'
const FALLBACK_TOKEN_ENVS = [
  'DISCORD_BOT_TOKEN',
  'KIMAKI_BOT_TOKEN',
  'BOT_TOKEN',
  'TOKEN',
] as const

type ProbeOutcome = {
  label: string
  status: 'resolved' | 'rejected' | 'timeout' | 'released-after-timeout'
  elapsedMs: number
  followupMessageAtMs?: number
  releaseMessageAtMs?: number
  errorMessage?: string
}

const cli = goke('validate-typing-indicator')

cli
  .command(
    '',
    'Create a real Discord thread and measure how long discord.js sendTyping() stays pending.',
  )
  .option(
    '--guild-id [guild-id]',
    z.string().default(DEFAULT_GUILD_ID).describe('Guild ID that owns the target text channel.'),
  )
  .option(
    '--channel-id [channel-id]',
    z.string().default(DEFAULT_CHANNEL_ID).describe('Text channel ID where the probe thread will be created.'),
  )
  .option(
    '--token-env [token-env]',
    z.string().default(DEFAULT_TOKEN_ENV).describe('Environment variable that contains the Discord bot token. Falls back to common Discord token env names when this one is missing.'),
  )
  .option(
    '--message-delay-ms [message-delay-ms]',
    z.number().default(DEFAULT_MESSAGE_DELAY_MS).describe('Delay before the follow-up bot message in the second probe.'),
  )
  .option(
    '--timeout-ms [timeout-ms]',
    z.number().default(DEFAULT_TIMEOUT_MS).describe('How long to wait before treating a typing request as still pending.'),
  )
  .option(
    '--keep-thread',
    'Keep the probe thread open instead of archiving it after the run finishes.',
  )
  .example('# Run with the package script (Doppler is already included)')
  .example('pnpm validate-typing-indicator')
  .action(async (options) => {
    const token = getToken({ tokenEnv: options.tokenEnv })
    if (token instanceof Error) {
      throw token
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
      ],
    })

    try {
      const loginResult = await errore.tryAsync(() => {
        return client.login(token)
      })
      if (loginResult instanceof Error) {
        throw new Error('Failed to login Discord client', { cause: loginResult })
      }

      const textChannel = await resolveTextChannel({
        client,
        guildId: options.guildId,
        channelId: options.channelId,
      })
      if (textChannel instanceof Error) {
        throw textChannel
      }

      const thread = await createProbeThread({
        textChannel,
        guildId: options.guildId,
      })
      if (thread instanceof Error) {
        throw thread
      }

      logger.log(`Probe thread: https://discord.com/channels/${options.guildId}/${thread.id}`)

      const typingOnly = await measureTypingRequest({
        thread,
        label: 'typing-only',
        timeoutMs: options.timeoutMs,
      })
      logProbeOutcome({ outcome: typingOnly })

      const typingThenMessage = await measureTypingRequest({
        thread,
        label: 'typing-then-message',
        timeoutMs: options.timeoutMs,
        followupMessageDelayMs: options.messageDelayMs,
      })
      logProbeOutcome({ outcome: typingThenMessage })

      if (!options.keepThread) {
        const archiveResult = await errore.tryAsync(() => {
          return thread.setArchived(true, 'Completed typing indicator probe')
        })
        if (archiveResult instanceof Error) {
          logger.warn('Failed to archive probe thread', archiveResult.message)
        }
      }
    } finally {
      client.destroy()
    }
  })

cli.help()
await cli.parse()

function getToken({ tokenEnv }: { tokenEnv: string }): Error | string {
  const token = process.env[tokenEnv]
  if (!token) {
    const fallbackName = FALLBACK_TOKEN_ENVS.find((name) => {
      return Boolean(process.env[name])
    })
    if (fallbackName) {
      logger.warn(
        `Missing ${tokenEnv}; using ${fallbackName} from environment instead`,
      )
      return process.env[fallbackName] || ''
    }
    return new Error(
      `Missing ${tokenEnv} environment variable. Also checked ${FALLBACK_TOKEN_ENVS.join(', ')}`,
    )
  }
  return token
}

async function resolveTextChannel({
  client,
  guildId,
  channelId,
}: {
  client: Client
  guildId: string
  channelId: string
}): Promise<Error | TextChannel> {
  const channelResult = await errore.tryAsync(() => {
    return client.channels.fetch(channelId)
  })
  if (channelResult instanceof Error) {
    return new Error('Failed to fetch target channel', { cause: channelResult })
  }
  if (!channelResult) {
    return new Error('Target channel was not found')
  }
  if (channelResult.type !== ChannelType.GuildText) {
    return new Error(`Target channel is not a guild text channel: ${channelResult.type}`)
  }
  if (channelResult.guildId !== guildId) {
    return new Error(`Target channel does not belong to guild ${guildId}`)
  }
  return channelResult
}

async function createProbeThread({
  textChannel,
  guildId,
}: {
  textChannel: TextChannel
  guildId: string
}): Promise<Error | ThreadChannel> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const seedMessageResult = await errore.tryAsync(() => {
    return textChannel.send(`Typing probe seed ${stamp}`)
  })
  if (seedMessageResult instanceof Error) {
    return new Error('Failed to send probe seed message', { cause: seedMessageResult })
  }

  const threadResult = await errore.tryAsync(() => {
    return seedMessageResult.startThread({
      name: `typing-probe-${stamp}`.slice(0, 80),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Typing request lifetime probe for guild ${guildId}`,
    })
  })
  if (threadResult instanceof Error) {
    return new Error('Failed to create probe thread', { cause: threadResult })
  }
  return threadResult
}

async function measureTypingRequest({
  thread,
  label,
  timeoutMs,
  followupMessageDelayMs,
}: {
  thread: ThreadChannel
  label: string
  timeoutMs: number
  followupMessageDelayMs?: number
}): Promise<ProbeOutcome> {
  const startTime = Date.now()

  const typingPromise = errore.tryAsync(() => {
    return thread.sendTyping()
  })

  const followupAtMsPromise = (() => {
    if (followupMessageDelayMs === undefined) {
      return Promise.resolve<number | undefined>(undefined)
    }
    return (async () => {
      await sleep({ ms: followupMessageDelayMs })
      const sendResult = await errore.tryAsync(() => {
        return thread.send(`Typing probe follow-up for ${label}`)
      })
      if (sendResult instanceof Error) {
        throw new Error('Failed to send follow-up probe message', { cause: sendResult })
      }
      return Date.now() - startTime
    })()
  })()

  const initialOutcome = await Promise.race([
    typingPromise.then((result) => {
      if (result instanceof Error) {
        return {
          status: 'rejected' as const,
          elapsedMs: Date.now() - startTime,
          errorMessage: result.message,
        }
      }
      return {
        status: 'resolved' as const,
        elapsedMs: Date.now() - startTime,
      }
    }),
    sleep({ ms: timeoutMs }).then(() => {
      return {
        status: 'timeout' as const,
        elapsedMs: Date.now() - startTime,
      }
    }),
  ])

  const followupMessageAtMs = await followupAtMsPromise

  if (initialOutcome.status !== 'timeout') {
    return {
      label,
      ...initialOutcome,
      followupMessageAtMs,
    }
  }

  const releaseMessageResult = await errore.tryAsync(() => {
    return thread.send(`Typing probe release for ${label}`)
  })
  if (releaseMessageResult instanceof Error) {
    return {
      label,
      ...initialOutcome,
      followupMessageAtMs,
      errorMessage: releaseMessageResult.message,
    }
  }

  const releaseMessageAtMs = Date.now() - startTime
  const releasedOutcome = await Promise.race([
    typingPromise.then((result) => {
      if (result instanceof Error) {
        return {
          status: 'rejected' as const,
          elapsedMs: Date.now() - startTime,
          errorMessage: result.message,
        }
      }
      return {
        status: 'released-after-timeout' as const,
        elapsedMs: Date.now() - startTime,
      }
    }),
    sleep({ ms: 5_000 }).then(() => {
      return {
        status: 'timeout' as const,
        elapsedMs: Date.now() - startTime,
      }
    }),
  ])

  return {
    label,
    ...releasedOutcome,
    followupMessageAtMs,
    releaseMessageAtMs,
  }
}

function logProbeOutcome({ outcome }: { outcome: ProbeOutcome }): void {
  logger.log(
    [
      `probe=${outcome.label}`,
      `status=${outcome.status}`,
      `elapsedMs=${outcome.elapsedMs}`,
      outcome.followupMessageAtMs !== undefined
        ? `followupMessageAtMs=${outcome.followupMessageAtMs}`
        : undefined,
      outcome.releaseMessageAtMs !== undefined
        ? `releaseMessageAtMs=${outcome.releaseMessageAtMs}`
        : undefined,
      outcome.errorMessage ? `error=${outcome.errorMessage}` : undefined,
    ].filter(isTruthy).join(' '),
  )
}

function isTruthy<T>(value: T): value is NonNullable<T> {
  return Boolean(value)
}

async function sleep({ ms }: { ms: number }): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
