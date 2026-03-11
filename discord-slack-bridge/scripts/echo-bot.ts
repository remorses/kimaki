// Echo bot: tests discord-slack-bridge against a real Slack workspace.
// Requires doppler env: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET.
// Usage: cd discord-slack-bridge && pnpm echo-bot
// Tunnel URL is stable — configure once in Slack Event Subscriptions.

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type Message,
  type StringSelectMenuInteraction,
  type ThreadChannel,
  type TextChannel,
} from 'discord.js'
import { WebClient } from '@slack/web-api'
import { TunnelClient } from 'traforo/client'
import { SlackBridge } from '../src/index.js'

const TUNNEL_ID = 'dsb-echo-bot'
const BRIDGE_PORT = Number(process.env.ECHO_BOT_PORT ?? '3710')
const OPEN_MODAL_BUTTON_ID = 'demo-open-modal'
const STATUS_BUTTON_ID = 'demo-status-button'
const TABLE_BUTTON_ID = 'demo-table-button'
const DEMO_SELECT_ID = 'demo-select'
const DEMO_MODAL_ID = 'demo-modal'
const DEMO_MODAL_INPUT_ID = 'demo-modal-input'

async function main(): Promise<void> {
  const slackBotToken = requireEnv('SLACK_BOT_TOKEN')
  const slackSigningSecret = requireEnv('SLACK_SIGNING_SECRET')

  const tempClient = new WebClient(slackBotToken)
  const authResult = await tempClient.auth.test()
  const workspaceId = authResult.team_id
  if (!workspaceId) {
    throw new Error('Could not resolve workspace ID from auth.test')
  }
  console.log(`Slack workspace: ${authResult.team} (${workspaceId})`)
  console.log(`Bot user: ${authResult.user} (${authResult.user_id})`)

  const bridge = new SlackBridge({
    slackBotToken,
    slackSigningSecret,
    workspaceId,
    port: BRIDGE_PORT,
  })
  await bridge.start()
  console.log(`Bridge: REST=${bridge.restUrl} Gateway=${bridge.gatewayUrl}`)

  const tunnel = new TunnelClient({
    localPort: bridge.port,
    tunnelId: TUNNEL_ID,
  })
  await tunnel.connect()
  const webhookUrl = `${tunnel.url}/slack/events`
  console.log(`Tunnel: ${tunnel.url}`)
  console.log(`Slack Event Subscriptions URL: ${webhookUrl}`)

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
    rest: { api: bridge.restUrl, version: '10' },
  })

  const readyPromise = new Promise<void>((resolve) => {
    client.once('ready', () => {
      resolve()
    })
  })

  await client.login(bridge.discordToken)
  await readyPromise

  const guild = client.guilds.cache.first()
  console.log(`Bot ready! Guild: ${guild?.name} (${guild?.id})`)
  const channels = await guild?.channels.fetch()
  const channelNames = channels?.map((c) => {
    return c?.name
  }).filter(Boolean)
  console.log(`Channels: ${channelNames?.join(', ')}`)

  client.on('messageCreate', (message) => {
    void handleMessageCreate({ client, message })
  })
  client.on('interactionCreate', (interaction) => {
    void handleInteractionCreate({ interaction })
  })

  console.log('\nEcho bot running. Press Ctrl+C to stop.\n')

  const shutdown = (): void => {
    console.log('\nShutting down...')
    client.destroy()
    tunnel.close()
    void bridge.stop().then(() => {
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function handleMessageCreate({
  client,
  message,
}: {
  client: Client
  message: Message
}): Promise<void> {
  const isSelf = client.user && message.author.id === client.user.id
  if (isSelf || message.author.bot) {
    return
  }

  const thread = await resolveReplyThread({ message })
  if (!thread) {
    return
  }

  console.log(`[echo] "${message.content}" from ${message.author.username}`)

  if (message.attachments.size > 0) {
    await thread.send(formatAttachmentSummary({ message }))
    return
  }

  const normalized = message.content.trim().toLowerCase()
  const handled = await handleDemoSwitch({
    command: normalized,
    thread,
    username: message.author.username,
  })
  if (handled) {
    return
  }

  await thread.send(`echo: ${message.content}`)
}

async function handleDemoSwitch({
  command,
  thread,
  username,
}: {
  command: string
  thread: ThreadChannel
  username: string
}): Promise<boolean> {
  switch (command) {
    case 'demo:buttons': {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(STATUS_BUTTON_ID)
          .setLabel('Show status')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(TABLE_BUTTON_ID)
          .setLabel('Show table')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(OPEN_MODAL_BUTTON_ID)
          .setLabel('Open modal')
          .setStyle(ButtonStyle.Success),
      )
      await thread.send({
        content: `Button demo for ${username}`,
        components: [row],
      })
      return true
    }
    case 'demo:select': {
      const select = new StringSelectMenuBuilder()
        .setCustomId(DEMO_SELECT_ID)
        .setPlaceholder('Pick an option')
        .addOptions([
          { label: 'Low', value: 'low', description: 'Minimal output' },
          { label: 'Medium', value: 'medium', description: 'Balanced output' },
          { label: 'High', value: 'high', description: 'Verbose output' },
        ])
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        select,
      )
      await thread.send({
        content: 'Select menu demo',
        components: [row],
      })
      return true
    }
    case 'demo:modal': {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(OPEN_MODAL_BUTTON_ID)
          .setLabel('Open input modal')
          .setStyle(ButtonStyle.Primary),
      )
      await thread.send({
        content: 'Click to open a modal input',
        components: [row],
      })
      return true
    }
    case 'demo:image': {
      const image = new AttachmentBuilder(Buffer.from(SMALL_PNG_BASE64, 'base64'), {
        name: 'demo-image.png',
      })
      await thread.send({
        content: 'Image upload demo',
        files: [image],
      })
      return true
    }
    case 'demo:text-file': {
      const file = new AttachmentBuilder(
        Buffer.from('demo text file\nbridge: discord-slack-bridge\n', 'utf8'),
        {
          name: 'demo-note.txt',
        },
      )
      await thread.send({
        content: 'Text file upload demo',
        files: [file],
      })
      return true
    }
    case 'demo:table': {
      await thread.send({
        content: [
          'Runtime table',
          '| Field | Value |',
          '| --- | --- |',
          `| User | ${username} |`,
          `| Channel | ${thread.parentId ?? 'unknown'} |`,
          `| Thread | ${thread.id} |`,
          `| Timestamp | ${new Date().toISOString()} |`,
        ].join('\n'),
      })
      return true
    }
    case 'demo:all': {
      const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(STATUS_BUTTON_ID)
          .setLabel('Show status')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(TABLE_BUTTON_ID)
          .setLabel('Show table')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(OPEN_MODAL_BUTTON_ID)
          .setLabel('Open modal')
          .setStyle(ButtonStyle.Success),
      )
      await thread.send({
        content: `Button demo for ${username}`,
        components: [buttonRow],
      })

      const select = new StringSelectMenuBuilder()
        .setCustomId(DEMO_SELECT_ID)
        .setPlaceholder('Pick an option')
        .addOptions([
          { label: 'Low', value: 'low', description: 'Minimal output' },
          { label: 'Medium', value: 'medium', description: 'Balanced output' },
          { label: 'High', value: 'high', description: 'Verbose output' },
        ])
      const selectRow =
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
      await thread.send({
        content: 'Select menu demo',
        components: [selectRow],
      })

      const image = new AttachmentBuilder(Buffer.from(SMALL_PNG_BASE64, 'base64'), {
        name: 'demo-image.png',
      })
      await thread.send({
        content: 'Image upload demo',
        files: [image],
      })

      const file = new AttachmentBuilder(
        Buffer.from('demo text file\nbridge: discord-slack-bridge\n', 'utf8'),
        {
          name: 'demo-note.txt',
        },
      )
      await thread.send({
        content: 'Text file upload demo',
        files: [file],
      })

      await thread.send({
        content: [
          'Runtime table',
          '| Field | Value |',
          '| --- | --- |',
          `| User | ${username} |`,
          `| Channel | ${thread.parentId ?? 'unknown'} |`,
          `| Thread | ${thread.id} |`,
          `| Timestamp | ${new Date().toISOString()} |`,
        ].join('\n'),
      })

      await thread.send({
        content: 'Modal demo: click "Open modal" from the button message above.',
      })
      return true
    }
    case 'demo:help': {
      await thread.send({
        content: [
          'Available demo commands:',
          '- demo:buttons',
          '- demo:select',
          '- demo:modal',
          '- demo:image',
          '- demo:text-file',
          '- demo:table',
          '- demo:all',
          '- demo:help',
        ].join('\n'),
      })
      return true
    }
    default: {
      return false
    }
  }
}

async function handleInteractionCreate({
  interaction,
}: {
  interaction: Interaction
}): Promise<void> {
  if (interaction.isButton()) {
    await handleButtonInteraction({ interaction })
    return
  }

  if (interaction.isStringSelectMenu()) {
    await handleSelectInteraction({ interaction })
    return
  }

  if (interaction.isModalSubmit()) {
    await handleModalSubmitInteraction({ interaction })
  }
}

async function handleButtonInteraction({
  interaction,
}: {
  interaction: ButtonInteraction
}): Promise<void> {
  if (interaction.customId === STATUS_BUTTON_ID) {
    await interaction.reply({
      content: 'Status button clicked',
      ephemeral: true,
    })
    return
  }

  if (interaction.customId === TABLE_BUTTON_ID) {
    await interaction.reply({
      content: [
        'Button-triggered table',
        '| Metric | Value |',
        '| --- | --- |',
        `| User | ${interaction.user.username} |`,
        `| Message ID | ${interaction.message.id} |`,
        `| Custom ID | ${interaction.customId} |`,
      ].join('\n'),
      ephemeral: true,
    })
    return
  }

  if (interaction.customId === OPEN_MODAL_BUTTON_ID) {
    const modal = new ModalBuilder()
      .setCustomId(DEMO_MODAL_ID)
      .setTitle('Demo input modal')
    const input = new TextInputBuilder()
      .setCustomId(DEMO_MODAL_INPUT_ID)
      .setLabel('Enter demo text')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input)
    modal.addComponents(row)
    await interaction.showModal(modal)
  }
}

async function handleSelectInteraction({
  interaction,
}: {
  interaction: StringSelectMenuInteraction
}): Promise<void> {
  const value = interaction.values[0] ?? 'unknown'
  await interaction.reply({
    content: `Selected: ${value}`,
    ephemeral: true,
  })
}

async function handleModalSubmitInteraction({
  interaction,
}: {
  interaction: ModalSubmitInteraction
}): Promise<void> {
  if (interaction.customId !== DEMO_MODAL_ID) {
    return
  }
  const value = interaction.fields.getTextInputValue(DEMO_MODAL_INPUT_ID)
  await interaction.reply({
    content: `Modal input: ${value}`,
    ephemeral: true,
  })
}

function formatAttachmentSummary({ message }: { message: Message }): string {
  const lines = [
    `Received ${message.attachments.size} attachment(s):`,
    '| Name | Mime | Size | Image |',
    '| --- | --- | --- | --- |',
  ]
  const rows = [...message.attachments.values()].map((attachment) => {
    const mime = attachment.contentType ?? 'unknown'
    const size = formatBytes(attachment.size)
    const imageSize =
      attachment.width && attachment.height
        ? `${attachment.width}x${attachment.height}`
        : 'n/a'
    return `| ${attachment.name ?? 'unknown'} | ${mime} | ${size} | ${imageSize} |`
  })
  return [...lines, ...rows].join('\n')
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const SMALL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9n0WcAAAAASUVORK5CYII='

async function resolveReplyThread({
  message,
}: {
  message: Message
}): Promise<ThreadChannel | undefined> {
  if (message.channel.isThread()) {
    return message.channel
  }

  const existingThread = message.thread
  if (existingThread) {
    return existingThread
  }

  if (!message.inGuild()) {
    return undefined
  }

  const threadName = `echo-${message.author.username}`.slice(0, 100)
  return createThreadForChannelMessage({ message, threadName })
}

async function createThreadForChannelMessage({
  message,
  threadName,
}: {
  message: Message<true>
  threadName: string
}): Promise<ThreadChannel | undefined> {
  try {
    return await message.startThread({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
    })
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error
    }
  }

  const channel = message.channel
  if (!isThreadCreatableChannel(channel)) {
    return undefined
  }

  return channel.threads.create({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
  })
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return 'status' in error && typeof error.status === 'number' && error.status === 404
}

function isThreadCreatableChannel(
  channel: Message<true>['channel'],
): channel is TextChannel {
  return 'threads' in channel
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
