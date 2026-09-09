// Slash commands. /queue, /abort, /new-session.

import {
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { Plugin } from '@opencode-ai/plugin'
import { canUseKimaki } from '../permissions/access.ts'
import { createThread, findByThreadId, getContext, getDirectoryForChannel, replaceThreadSession } from '../threads/registry.ts'
import { logPluginError } from '../discord/client.ts'

const queueCommand = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Queue a message for the next idle turn')
  .addStringOption((option) =>
    option.setName('message').setDescription('Message to queue').setRequired(true),
  )
  .setDMPermission(false)
  .toJSON()

const abortCommand = new SlashCommandBuilder()
  .setName('abort')
  .setDescription('Abort the current session turn')
  .setDMPermission(false)
  .toJSON()

const newSessionCommand = new SlashCommandBuilder()
  .setName('new-session')
  .setDescription('Start a new OpenCode session')
  .addStringOption((option) =>
    option.setName('prompt').setDescription('First message for the new session').setRequired(false),
  )
  .setDMPermission(false)
  .toJSON()

async function registerGuildCommands({
  token,
  restApi,
  clientId,
  guildId,
}: {
  token: string
  restApi?: string
  clientId: string
  guildId: string
}) {
  const rest = new REST({ version: '10', api: restApi }).setToken(token)
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: [queueCommand, abortCommand, newSessionCommand],
  })
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error), { cause: error })
}

function usernameOfInteraction(interaction: ChatInputCommandInteraction) {
  return interaction.member && 'displayName' in interaction.member
    ? String(interaction.member.displayName)
    : interaction.user.displayName || interaction.user.username
}

async function denyUnlessKimaki(interaction: ChatInputCommandInteraction) {
  if (canUseKimaki(interaction)) return false
  await interaction.reply({ content: 'You cannot use this command.', ephemeral: true })
  return true
}

export async function handleQueueCommand(interaction: ChatInputCommandInteraction) {
  if (await denyUnlessKimaki(interaction)) return
  const message = interaction.options.getString('message', true)
  const channel = interaction.channel
  if (!channel?.isThread()) {
    await interaction.reply({ content: '/queue only works in a session thread.', ephemeral: true })
    return
  }
  const record = findByThreadId(channel.id)
  if (!record) {
    await interaction.reply({ content: 'No OpenCode session is bound to this thread.', ephemeral: true })
    return
  }
  const ctx = getContext(record.directory)
  if (!ctx) {
    await interaction.reply({ content: 'OpenCode location is gone.', ephemeral: true })
    return
  }
  await interaction.deferReply({ ephemeral: true })
  const prompted = await ctx.session
    .prompt({
      sessionID: record.sessionId,
      text: message,
      delivery: 'queue',
      metadata: { username: usernameOfInteraction(interaction), userId: interaction.user.id },
    })
    .catch(asError)
  if (prompted instanceof Error) {
    logPluginError(prompted)
    await interaction.editReply({ content: 'Could not queue that message.' })
    return
  }
  await interaction.editReply({ content: `Queued: ${message.slice(0, 120)}` })
}

export async function handleAbortCommand(interaction: ChatInputCommandInteraction) {
  if (await denyUnlessKimaki(interaction)) return
  const channel = interaction.channel
  if (!channel?.isThread()) {
    await interaction.reply({ content: '/abort only works in a session thread.', ephemeral: true })
    return
  }
  const record = findByThreadId(channel.id)
  if (!record) {
    await interaction.reply({ content: 'No OpenCode session is bound to this thread.', ephemeral: true })
    return
  }
  const ctx = getContext(record.directory)
  if (!ctx) {
    await interaction.reply({ content: 'OpenCode location is gone.', ephemeral: true })
    return
  }
  await interaction.deferReply({ ephemeral: true })
  const interrupted = await ctx.session
    .interrupt({ sessionID: record.sessionId })
    .catch(asError)
  if (interrupted instanceof Error) {
    logPluginError(interrupted)
    await interaction.editReply({ content: 'Could not abort that session.' })
    return
  }
  await interaction.editReply({ content: 'Aborted.' })
}

export async function handleNewSessionCommand(interaction: ChatInputCommandInteraction) {
  if (await denyUnlessKimaki(interaction)) return
  const prompt = interaction.options.getString('prompt')
  const channel = interaction.channel
  if (!channel) {
    await interaction.reply({ content: 'This command needs a channel.', ephemeral: true })
    return
  }
  if (channel.type === ChannelType.GuildText) {
    if (!prompt) {
      await interaction.reply({ content: '/new-session in a text channel needs a prompt.', ephemeral: true })
      return
    }
    const directory = getDirectoryForChannel(channel.id)
    if (!directory) {
      await interaction.reply({ content: 'This channel is not a Kimaki project.', ephemeral: true })
      return
    }
    const ctx = getContext(directory)
    if (!ctx) {
      await interaction.reply({ content: 'OpenCode location is gone.', ephemeral: true })
      return
    }
    await interaction.deferReply({ ephemeral: true })
    const starter = await channel.send({ content: prompt })
    const thread = await starter.startThread({
      name: prompt.slice(0, 80),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    })
    await thread.members.add(interaction.user.id)
    const created = await ctx.session.create({ title: thread.name }).catch(asError)
    if (created instanceof Error) {
      logPluginError(created)
      await interaction.editReply({ content: 'Could not start a new session.' })
      return
    }
    await createThread({
      threadId: thread.id,
      sessionId: created.id,
      directory,
      userId: interaction.user.id,
      username: usernameOfInteraction(interaction),
      startedAt: Date.now(),
    })
    const prompted = await ctx.session
      .prompt({
        sessionID: created.id,
        text: prompt,
        metadata: { username: usernameOfInteraction(interaction), userId: interaction.user.id },
      })
      .catch(asError)
    if (prompted instanceof Error) {
      logPluginError(prompted)
      await interaction.editReply({ content: 'Could not send the first prompt.' })
      return
    }
    await interaction.editReply({ content: `Started a new session in <#${thread.id}>.` })
    return
  }
  if (!channel.isThread()) {
    await interaction.reply({ content: '/new-session only works in a project channel or session thread.', ephemeral: true })
    return
  }
  const record = findByThreadId(channel.id)
  if (!record) {
    await interaction.reply({ content: 'No OpenCode session is bound to this thread.', ephemeral: true })
    return
  }
  const ctx = getContext(record.directory)
  if (!ctx) {
    await interaction.reply({ content: 'OpenCode location is gone.', ephemeral: true })
    return
  }
  await interaction.deferReply({ ephemeral: true })
  const created = await ctx.session.create({ title: channel.name }).catch(asError)
  if (created instanceof Error) {
    logPluginError(created)
    await interaction.editReply({ content: 'Could not start a new session.' })
    return
  }
  const replaced = await replaceThreadSession({ threadId: channel.id, sessionId: created.id })
  if (!replaced) {
    await interaction.editReply({ content: 'Could not bind the new session to this thread.' })
    return
  }
  if (!prompt) {
    await interaction.editReply({ content: 'Started a new session.' })
    return
  }
  const prompted = await ctx.session
    .prompt({
      sessionID: created.id,
      text: prompt,
      metadata: { username: usernameOfInteraction(interaction), userId: interaction.user.id },
    })
    .catch(asError)
  if (prompted instanceof Error) {
    logPluginError(prompted)
    await interaction.editReply({ content: 'Could not send the first prompt.' })
    return
  }
  await interaction.editReply({ content: 'Started a new session.' })
}

export default Plugin.define({
  id: 'kimaki.commands',
  async setup(ctx) {
    const token = typeof ctx.options['token'] === 'string' ? ctx.options['token'] : process.env['KIMAKI_BOT_TOKEN']
    const restApi = typeof ctx.options['restApi'] === 'string' ? ctx.options['restApi'] : undefined
    const clientId = typeof ctx.options['clientId'] === 'string' ? ctx.options['clientId'] : undefined
    const guildId = typeof ctx.options['guildId'] === 'string' ? ctx.options['guildId'] : undefined
    if (token && clientId && guildId) {
      await registerGuildCommands({ token, restApi, clientId, guildId }).catch(logPluginError)
    }
  },
})
