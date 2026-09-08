// Slash commands. /queue prompts with delivery queue.

import { REST, Routes, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { Plugin } from '@opencode-ai/plugin'
import { findByThreadId, getContext } from '../threads/registry.ts'
import { logPluginError } from '../discord/client.ts'

const queueCommand = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Queue a message for the next idle turn')
  .addStringOption((option) =>
    option.setName('message').setDescription('Message to queue').setRequired(true),
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
    body: [queueCommand],
  })
}

export async function handleQueueCommand(interaction: ChatInputCommandInteraction) {
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
  const username =
    interaction.member && 'displayName' in interaction.member
      ? String(interaction.member.displayName)
      : interaction.user.displayName || interaction.user.username
  const prompted = await ctx.session
    .prompt({
      sessionID: record.sessionId,
      text: message,
      delivery: 'queue',
      metadata: { username, userId: interaction.user.id },
    })
    .catch((error: unknown) => error)
  if (prompted instanceof Error) {
    logPluginError(prompted)
    await interaction.editReply({ content: 'Could not queue that message.' })
    return
  }
  await interaction.editReply({ content: `Queued: ${message.slice(0, 120)}` })
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
