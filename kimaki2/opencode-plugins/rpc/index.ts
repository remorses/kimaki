// Kimaki RPC. send() creates a session for a mapped Discord channel.

import { ChannelType, ThreadAutoArchiveDuration } from 'discord.js'
import { Plugin } from '@opencode-ai/plugin'
import { getClient } from '../discord/client.ts'
import { createThread, getContext, getDirectoryForChannel } from '../threads/registry.ts'
import { Kimaki } from './definition.ts'

export default Plugin.define({
  id: 'kimaki.rpc',
  async setup(ctx) {
    await ctx.rpc.register(Kimaki, {
      send: async (raw, context) => {
        const input = raw as { channelID?: string; prompt?: string; userID?: string }
        const channelID = typeof input.channelID === 'string' ? input.channelID : ''
        const prompt = typeof input.prompt === 'string' ? input.prompt : ''
        const directory = getDirectoryForChannel(channelID)
        if (!directory) return context.error('unknown_channel', 'Channel is not a Kimaki project', { channelID })
        const slot = getContext(directory)
        if (!slot) return context.error('unknown_channel', 'OpenCode location is gone', { channelID })
        const client = getClient()
        if (!client) return context.error('unknown_channel', 'Discord is not connected', { channelID })
        const channel = await client.channels.fetch(channelID)
        if (!channel || channel.type !== ChannelType.GuildText) {
          return context.error('unknown_channel', 'Channel is not a text channel', { channelID })
        }
        const created = await slot.session.create({ title: prompt.slice(0, 80) || 'kimaki' })
        const thread = await channel.threads.create({
          name: (prompt.slice(0, 80) || 'kimaki').trim(),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        })
        await createThread({
          threadId: thread.id,
          sessionId: created.id,
          directory,
          userId: typeof input.userID === 'string' ? input.userID : '',
          username: 'rpc',
          startedAt: Date.now(),
        })
        await slot.session.prompt({
          sessionID: created.id,
          text: prompt,
          metadata: typeof input.userID === 'string' ? { userId: input.userID } : {},
        })
        return { sessionID: created.id, threadID: thread.id }
      },
    })
  },
})
