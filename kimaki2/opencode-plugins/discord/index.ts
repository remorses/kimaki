// Discord gateway once. MessageCreate starts a thread and prompts the session.

import { ChannelType, ThreadAutoArchiveDuration, type Interaction, type Message } from 'discord.js'
import { Plugin } from '@opencode-ai/plugin'
import { extractBtwSuffix } from '../../src/btw-suffix.ts'
import { threadNameFromMessage, usernameOf } from '../../src/discord-text.ts'
import { startSideSession } from '../btw/side-session.ts'
import { handleAbortCommand, handleNewSessionCommand, handleQueueCommand } from '../commands/index.ts'
import { handlePermissionButton } from '../permissions/index.ts'
import { createThread, findByThreadId, getContext, getDirectoryForChannel } from '../threads/registry.ts'
import { acquireDiscord, releaseDiscord } from './client.ts'

async function onMessage(message: Message) {
  if (message.author.bot) return
  const channel = message.channel
  if (channel.type === ChannelType.GuildText) {
    const directory = getDirectoryForChannel(channel.id)
    if (!directory) return
    const ctx = getContext(directory)
    if (!ctx) return
    const thread = await message.startThread({
      name: threadNameFromMessage(message),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    })
    await thread.members.add(message.author.id)
    const created = await ctx.session.create({ title: thread.name })
    await createThread({
      threadId: thread.id,
      sessionId: created.id,
      directory,
      userId: message.author.id,
      username: usernameOf(message),
      startedAt: Date.now(),
    })
    await ctx.session.prompt({
      sessionID: created.id,
      text: message.content,
      metadata: { username: usernameOf(message), userId: message.author.id },
    })
    return
  }
  if (!channel.isThread()) return
  const record = findByThreadId(channel.id)
  if (!record) return
  if (extractBtwSuffix(message.content).forceBtw) {
    await startSideSession({
      text: message.content,
      sourceThreadId: channel.id,
      userId: message.author.id,
      username: usernameOf(message),
      sourceChannel: channel,
    })
    return
  }
  const ctx = getContext(record.directory)
  if (!ctx) return
  await ctx.session.prompt({
    sessionID: record.sessionId,
    text: message.content,
    metadata: { username: usernameOf(message), userId: message.author.id },
  })
}

export default Plugin.define({
  id: 'kimaki.discord',
  async setup(ctx) {
    const token = typeof ctx.options['token'] === 'string' ? ctx.options['token'] : process.env['KIMAKI_BOT_TOKEN']
    if (!token) return
    const restApi = typeof ctx.options['restApi'] === 'string' ? ctx.options['restApi'] : undefined
    await acquireDiscord({
      token,
      restApi,
      onMessage,
      onInteraction: async (interaction: Interaction) => {
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName === 'queue') {
            await handleQueueCommand(interaction)
            return
          }
          if (interaction.commandName === 'abort') {
            await handleAbortCommand(interaction)
            return
          }
          if (interaction.commandName === 'new-session') {
            await handleNewSessionCommand(interaction)
            return
          }
        }
        if (!interaction.isButton()) return
        await handlePermissionButton(interaction)
      },
    })
    return () => {
      releaseDiscord()
    }
  },
})
