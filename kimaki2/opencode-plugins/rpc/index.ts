// Kimaki RPC. send/prompt/abort against mapped Discord channels and threads.

import { ChannelType, ThreadAutoArchiveDuration } from 'discord.js'
import { Plugin } from '@opencode-ai/plugin'
import { Kimaki } from '../../src/kimaki-rpc.ts'
import { getClient } from '../discord/client.ts'
import { createThread, findByThreadId, getContext, getDirectoryForChannel } from '../threads/registry.ts'

export default Plugin.define({
  id: 'kimaki.rpc',
  async setup(ctx) {
    await ctx.rpc.register(Kimaki, {
      send: async (raw, context) => {
        const input = parseSendInput(raw)
        const directory = getDirectoryForChannel(input.channelID)
        if (!directory) {
          return context.error('unknown_channel', 'Channel is not a Kimaki project', {
            channelID: input.channelID,
          })
        }
        const slot = getContext(directory)
        if (!slot) {
          return context.error('unknown_channel', 'OpenCode location is gone', {
            channelID: input.channelID,
          })
        }
        if (globalThis.__kimaki2DiscordStarting) await globalThis.__kimaki2DiscordStarting
        const client = getClient()
        if (!client) {
          return context.error('unknown_channel', 'Discord is not connected', {
            channelID: input.channelID,
          })
        }
        const channel = await client.channels.fetch(input.channelID)
        if (!channel || channel.type !== ChannelType.GuildText) {
          return context.error('unknown_channel', 'Channel is not a text channel', {
            channelID: input.channelID,
          })
        }
        const created = await slot.session.create({ title: input.prompt.slice(0, 80) || 'kimaki' })
        const thread = await channel.threads.create({
          name: (input.prompt.slice(0, 80) || 'kimaki').trim(),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        })
        await createThread({
          threadId: thread.id,
          sessionId: created.id,
          directory,
          userId: input.userID ?? '',
          username: 'rpc',
          startedAt: Date.now(),
        })
        await slot.session.prompt({
          sessionID: created.id,
          text: input.prompt,
          metadata: input.userID ? { userId: input.userID } : {},
        })
        return { sessionID: created.id, threadID: thread.id }
      },
      prompt: async (raw, context) => {
        const input = parsePromptInput(raw)
        const record = findByThreadId(input.threadID)
        if (!record) {
          return context.error('unknown_thread', 'Thread is not a Kimaki session', {
            threadID: input.threadID,
          })
        }
        const slot = getContext(record.directory)
        if (!slot) {
          return context.error('unknown_thread', 'OpenCode location is gone', {
            threadID: input.threadID,
          })
        }
        await slot.session.prompt({
          sessionID: record.sessionId,
          text: input.prompt,
          metadata: input.userID ? { userId: input.userID } : {},
          delivery: input.delivery === 'queue' ? 'queue' : 'steer',
        })
        return { sessionID: record.sessionId, threadID: record.threadId }
      },
      abort: async (raw, context) => {
        const input = parseAbortInput(raw)
        const record = findByThreadId(input.threadID)
        if (!record) {
          return context.error('unknown_thread', 'Thread is not a Kimaki session', {
            threadID: input.threadID,
          })
        }
        const slot = getContext(record.directory)
        if (!slot) {
          return context.error('unknown_thread', 'OpenCode location is gone', {
            threadID: input.threadID,
          })
        }
        await slot.session.interrupt({ sessionID: record.sessionId })
        return { ok: true as const, sessionID: record.sessionId }
      },
    })
  },
})

function parseSendInput(raw: unknown) {
  const value = asRecord(raw)
  return {
    channelID: stringField(value, 'channelID'),
    prompt: stringField(value, 'prompt'),
    userID: optionalStringField(value, 'userID'),
  }
}

function parsePromptInput(raw: unknown) {
  const value = asRecord(raw)
  const delivery = optionalStringField(value, 'delivery')
  return {
    threadID: stringField(value, 'threadID'),
    prompt: stringField(value, 'prompt'),
    userID: optionalStringField(value, 'userID'),
    delivery: delivery === 'queue' || delivery === 'steer' ? delivery : undefined,
  }
}

function parseAbortInput(raw: unknown) {
  return { threadID: stringField(asRecord(raw), 'threadID') }
}

function asRecord(raw: unknown) {
  if (!raw || typeof raw !== 'object') return {}
  return raw as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key]
  return typeof field === 'string' ? field : ''
}

function optionalStringField(value: Record<string, unknown>, key: string) {
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}
