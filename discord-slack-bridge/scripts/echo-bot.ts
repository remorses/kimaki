// Echo bot: tests discord-slack-bridge against a real Slack workspace.
// Required env vars: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET.
// Required Slack app setup:
// - Event Subscriptions Request URL -> {tunnel}/slack/events
// - Interactivity & Shortcuts Request URL -> {tunnel}/slack/events
// - Bot token scope includes files:write for demo:image and demo:text-file.
// Usage: cd discord-slack-bridge && pnpm echo-bot

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  SeparatorSpacingSize,
  type ChatInputCommandInteraction,
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
import fs from 'node:fs'
import { WebClient } from '@slack/web-api'
import {
  MessageFlags,
  Routes,
  type APIContainerComponent,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord-api-types/v10'
import { TunnelClient } from 'traforo/client'
import { SlackBridge } from '../src/index.js'

const TUNNEL_ID = 'dsb-echo-bot'
const BRIDGE_PORT = Number(process.env.ECHO_BOT_PORT ?? '3710')
const PREVIEW_GATEWAY_BASE_URL = 'https://preview-slack-gateway.kimaki.xyz'
const PREVIEW_WORKSPACE_ID = 'T08NQ7ULTUL'
const PREVIEW_CLIENT_ID = 'echo-bot-client'
const OPEN_MODAL_BUTTON_ID = 'demo-open-modal'
const STATUS_BUTTON_ID = 'demo-status-button'
const TABLE_BUTTON_ID = 'demo-table-button'
const DEMO_SELECT_ID = 'demo-select'
const DEMO_MODAL_ID = 'demo-modal'
const DEMO_MODAL_INPUT_ID = 'demo-modal-input'
const DEMO_IMAGE_FILE_URL = new URL('./demo-image.jpeg', import.meta.url)
const DEMO_COMMANDS: RESTPostAPIApplicationCommandsJSONBody[] = [
  { name: 'demo-buttons', description: 'Send button demo message' },
  { name: 'demo-select', description: 'Send select demo message' },
  { name: 'demo-modal', description: 'Send modal demo trigger button' },
  { name: 'demo-typing', description: 'Show typing indicator then send reply' },
  { name: 'demo-image', description: 'Send image upload demo' },
  { name: 'demo-text-file', description: 'Send text file upload demo' },
  { name: 'demo-table', description: 'Send table demo' },
  { name: 'demo-all', description: 'Run all demos' },
  { name: 'demo-help', description: 'Show available demo commands' },
]

async function main(): Promise<void> {
  const slackBotToken = requireEnv('SLACK_BOT_TOKEN')
  const slackSigningSecret = requireEnv('SLACK_SIGNING_SECRET')
  const gatewayMode = readGatewayModeArgv()

  const tempClient = new WebClient(slackBotToken)
  const authResult = await tempClient.auth.test()
  const workspaceId = authResult.team_id
  if (!workspaceId) {
    throw new Error('Could not resolve workspace ID from auth.test')
  }
  console.log(`Slack workspace: ${authResult.team} (${workspaceId})`)
  console.log(`Bot user: ${authResult.user} (${authResult.user_id})`)

  const localRuntime = gatewayMode
    ? null
    : await startLocalRuntime({
        slackBotToken,
        slackSigningSecret,
        workspaceId,
      })

  const gatewayRuntime = gatewayMode
    ? createDeployedRuntime({
        slackBotToken,
        gatewayMode,
      })
    : {
        restUrl: localRuntime?.bridge.restUrl ?? '',
        gatewayUrl: localRuntime?.bridge.gatewayUrl ?? '',
        discordToken: localRuntime?.bridge.discordToken ?? '',
        slackWebhookUrl: localRuntime?.slackWebhookUrl ?? '',
        workspaceId,
      }

  if (!gatewayMode && localRuntime) {
    console.log(`Bridge: REST=${localRuntime.bridge.restUrl} Gateway=${localRuntime.bridge.gatewayUrl}`)
    console.log(`Tunnel: ${localRuntime.tunnel.url}`)
  }

  if (gatewayMode) {
    console.log(`Gateway mode: using deployed bridge at ${gatewayMode.baseUrl}`)
  }

  console.log(`Slack Event Subscriptions URL: ${gatewayRuntime.slackWebhookUrl}`)
  console.log(`Slack Interactivity Request URL: ${gatewayRuntime.slackWebhookUrl}`)
  console.log(
    'Required bot scopes for demos: chat:write, channels:read, channels:history, groups:read, groups:history, files:write',
  )

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
    rest: { api: gatewayRuntime.restUrl, version: '10' },
  })

  const readyPromise = new Promise<void>((resolve) => {
    client.once('ready', () => {
      resolve()
    })
  })

  await client.login(gatewayRuntime.discordToken)
  await readyPromise

  const guild = client.guilds.cache.get(gatewayRuntime.workspaceId)
    ?? client.guilds.cache.first()
  console.log(`Bot ready! Guild: ${guild?.name} (${guild?.id})`)
  const channels = await guild?.channels.fetch()
  const channelNames = channels?.map((c) => {
    return c?.name
  }).filter(Boolean)
  console.log(`Channels: ${channelNames?.join(', ')}`)

  if (guild && client.user) {
    await registerDemoCommands({
      client,
      applicationId: client.user.id,
      guildId: guild.id,
    })
  }

  client.on('messageCreate', (message) => {
    void handleMessageCreate({ client, message }).catch((error) => {
      console.error('messageCreate handler failed', error)
    })
  })
  client.on('interactionCreate', (interaction) => {
    void handleInteractionCreate({ interaction }).catch((error) => {
      console.error('interactionCreate handler failed', error)
    })
  })

  console.log('\nEcho bot running. Press Ctrl+C to stop.\n')

  const shutdown = (): void => {
    console.log('\nShutting down...')
    client.destroy()
    localRuntime?.tunnel.close()
    void (localRuntime?.bridge.stop() ?? Promise.resolve()).then(() => {
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('unhandledRejection', (error) => {
    console.error('unhandledRejection', describeError(error))
  })
  process.on('uncaughtException', (error) => {
    console.error('uncaughtException', describeError(error))
  })
}

async function startLocalRuntime({
  slackBotToken,
  slackSigningSecret,
  workspaceId,
}: {
  slackBotToken: string
  slackSigningSecret: string
  workspaceId: string
}): Promise<{
  bridge: SlackBridge
  tunnel: TunnelClient
  slackWebhookUrl: string
}> {
  const bridge = new SlackBridge({
    slackBotToken,
    slackSigningSecret,
    workspaceId,
    port: BRIDGE_PORT,
  })
  await bridge.start()

  const tunnel = new TunnelClient({
    localPort: bridge.port,
    tunnelId: TUNNEL_ID,
  })
  await tunnel.connect()

  return {
    bridge,
    tunnel,
    slackWebhookUrl: `${tunnel.url}/slack/events`,
  }
}

function createDeployedRuntime({
  slackBotToken,
  gatewayMode,
}: {
  slackBotToken: string
  gatewayMode: { baseUrl: string }
}): {
  restUrl: string
  gatewayUrl: string
  discordToken: string
  slackWebhookUrl: string
  workspaceId: string
} {
  const baseUrl = new URL(gatewayMode.baseUrl)
  const gatewayUrl = new URL('/gateway', baseUrl)
  gatewayUrl.protocol = gatewayUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  gatewayUrl.searchParams.set(
    'clientId',
    process.env.ECHO_BOT_CLIENT_ID ?? PREVIEW_CLIENT_ID,
  )
  return {
    restUrl: new URL('/api', baseUrl).toString(),
    gatewayUrl: gatewayUrl.toString(),
    discordToken: process.env.ECHO_BOT_GATEWAY_TOKEN ?? slackBotToken,
    slackWebhookUrl: new URL('/slack/events', baseUrl).toString(),
    workspaceId: process.env.ECHO_BOT_WORKSPACE_ID ?? PREVIEW_WORKSPACE_ID,
  }
}

function readGatewayModeArgv(): { baseUrl: string } | null {
  const args = process.argv.slice(2)
  const gatewayFlag = args.find((arg) => {
    return arg === '--gateway' || arg.startsWith('--gateway=')
  })

  if (!gatewayFlag) {
    return null
  }

  const value = gatewayFlag.startsWith('--gateway=')
    ? gatewayFlag.slice('--gateway='.length)
    : PREVIEW_GATEWAY_BASE_URL
  const baseUrl = new URL(value).toString()
  return { baseUrl }
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
  const target = thread ?? message.channel

  console.log(`[echo] "${message.content}" from ${message.author.username}`)

  await pulseTyping({
    target,
    context: 'message:start',
  })

  if (message.attachments.size > 0) {
    const sent = await trySend({
      target,
      payload: formatAttachmentSummary({ message }),
      context: 'attachment summary response',
    })
    if (!sent) {
      await trySend({
        target,
        payload: 'Could not send attachment summary (bridge returned an error).',
        context: 'attachment summary fallback',
      })
    }
    return
  }

  const normalized = message.content.trim().toLowerCase()
  const handled = thread
    ? await handleDemoSwitch({
        client,
        command: normalized,
        thread,
        username: message.author.username,
      })
    : false
  if (handled) {
    return
  }

  const sent = await trySend({
    target,
    payload: `echo: ${message.content}`,
    context: 'default echo',
  })
  if (!sent) {
    await trySend({
      target,
      payload: 'Echo failed (bridge returned an error).',
      context: 'default echo fallback',
    })
  }
}

async function handleDemoSwitch({
  client,
  command,
  thread,
  username,
}: {
  client: Client
  command: string
  thread: ThreadChannel
  username: string
}): Promise<boolean> {
  await pulseTyping({
    target: thread,
    context: `demo:${command || 'empty'}`,
  })

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
    case 'demo:typing': {
      await pulseTyping({
        target: thread,
        context: 'demo:typing pre-delay',
      })
      await sleep({
        ms: 3000,
      })
      const sent = await trySend({
        target: thread,
        payload: 'Typing demo done after 3 seconds.',
        context: 'demo:typing message',
      })
      if (!sent) {
        await thread.send('Typing demo failed (bridge returned an error).')
      }
      return true
    }
    case 'demo:image': {
      const image = createDemoImageAttachment()
      const sent = await trySend({
        target: thread,
        payload: {
          content: 'Image upload demo',
          files: [image],
        },
        context: 'demo:image upload',
      })
      if (!sent) {
        await thread.send(
          'Image upload demo failed. Check bridge logs for missing_scope (files:write) or multipart upload issues.',
        )
      }
      return true
    }
    case 'demo:text-file': {
      const file = new AttachmentBuilder(
        Buffer.from('demo text file\nbridge: discord-slack-bridge\n', 'utf8'),
        {
          name: 'demo-note.txt',
        },
      )
      const sent = await trySend({
        target: thread,
        payload: {
          content: 'Text file upload demo',
          files: [file],
        },
        context: 'demo:text-file upload',
      })
      if (!sent) {
        await thread.send(
          'Text file upload demo failed. Check bridge logs for missing_scope (files:write) or multipart upload issues.',
        )
      }
      return true
    }
    case 'demo:table': {
      const sent = await sendV2TableMessage({
        client,
        thread,
        username,
        title: 'Runtime table',
      })
      if (!sent) {
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
      }
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

      const image = createDemoImageAttachment()
      const imageSent = await trySend({
        target: thread,
        payload: {
          content: 'Image upload demo',
          files: [image],
        },
        context: 'demo:all image upload',
      })
      if (!imageSent) {
        await thread.send(
          'Image upload demo failed. Check bridge logs for missing_scope (files:write) or multipart upload issues.',
        )
      }

      const file = new AttachmentBuilder(
        Buffer.from('demo text file\nbridge: discord-slack-bridge\n', 'utf8'),
        {
          name: 'demo-note.txt',
        },
      )
      const fileSent = await trySend({
        target: thread,
        payload: {
          content: 'Text file upload demo',
          files: [file],
        },
        context: 'demo:all text upload',
      })
      if (!fileSent) {
        await thread.send(
          'Text file upload demo failed. Check bridge logs for missing_scope (files:write) or multipart upload issues.',
        )
      }

      const tableSent = await sendV2TableMessage({
        client,
        thread,
        username,
        title: 'Runtime table',
      })
      if (!tableSent) {
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
      }

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
            '- demo:typing',
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
    console.log('interactionCreate button', {
      customId: interaction.customId,
      userId: interaction.user.id,
    })
    await handleButtonInteraction({ interaction })
    return
  }

  if (interaction.isChatInputCommand()) {
    console.log('interactionCreate slash command', {
      name: interaction.commandName,
      userId: interaction.user.id,
    })
    await handleSlashCommandInteraction({
      client: interaction.client,
      interaction,
    })
    return
  }

  if (interaction.isStringSelectMenu()) {
    console.log('interactionCreate select', {
      customId: interaction.customId,
      values: interaction.values,
      userId: interaction.user.id,
    })
    await handleSelectInteraction({ interaction })
    return
  }

  if (interaction.isModalSubmit()) {
    console.log('interactionCreate modal', {
      customId: interaction.customId,
      userId: interaction.user.id,
    })
    await handleModalSubmitInteraction({ interaction })
  }
}

async function handleSlashCommandInteraction({
  client,
  interaction,
}: {
  client: Client
  interaction: ChatInputCommandInteraction
}): Promise<void> {
  await interaction.deferReply({
    ephemeral: true,
  })

  const thread = await resolveReplyThreadFromInteraction({ interaction })
  if (!thread) {
    await interaction.editReply('Could not resolve or create a reply thread in this channel.')
    return
  }

  await pulseTyping({
    thread,
    context: `slash:${interaction.commandName}`,
  })

  const handled = await handleDemoSwitch({
    client,
    command: toDemoTextCommand({ slashCommandName: interaction.commandName }),
    thread,
    username: interaction.user.username,
  })
  if (!handled) {
    await interaction.editReply(`Unknown demo command: ${interaction.commandName}`)
    return
  }

  await interaction.editReply(`Ran ${interaction.commandName} in <#${thread.id}>`)
}

function toDemoTextCommand({
  slashCommandName,
}: {
  slashCommandName: string
}): string {
  return slashCommandName.replace('-', ':')
}

async function registerDemoCommands({
  client,
  applicationId,
  guildId,
}: {
  client: Client
  applicationId: string
  guildId: string
}): Promise<void> {
  await client.rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
    body: DEMO_COMMANDS,
  })
  console.log('Registered guild slash commands', {
    commandNames: DEMO_COMMANDS.map((command) => {
      return command.name
    }),
    guildId,
  })
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

async function sleep({ ms }: { ms: number }): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

async function sendV2TableMessage({
  client,
  thread,
  username,
  title,
}: {
  client: Client
  thread: ThreadChannel
  username: string
  title: string
}): Promise<boolean> {
  const container: APIContainerComponent = {
    type: ComponentType.Container,
    components: [
      {
        type: ComponentType.TextDisplay,
        content: `**Field** User\n**Value** ${username}`,
      },
      {
        type: ComponentType.Separator,
        divider: true,
        spacing: SeparatorSpacingSize.Small,
      },
      {
        type: ComponentType.TextDisplay,
        content: `**Field** Channel\n**Value** ${thread.parentId ?? 'unknown'}`,
      },
      {
        type: ComponentType.Separator,
        divider: true,
        spacing: SeparatorSpacingSize.Small,
      },
      {
        type: ComponentType.TextDisplay,
        content: `**Field** Thread\n**Value** ${thread.id}`,
      },
      {
        type: ComponentType.Separator,
        divider: true,
        spacing: SeparatorSpacingSize.Small,
      },
      {
        type: ComponentType.TextDisplay,
        content: `**Field** Title\n**Value** ${title}`,
      },
    ],
  }

  try {
    await client.rest.post(Routes.channelMessages(thread.id), {
      body: {
        flags: MessageFlags.IsComponentsV2,
        components: [container],
      },
    })
    return true
  } catch (error) {
    console.warn('v2 table send failed', {
      details: describeError(error),
    })
    return false
  }
}

async function pulseTyping({
  target,
  context,
}: {
  target: EchoReplyTarget
  context: string
}): Promise<void> {
  try {
    await target.sendTyping()
  } catch (error) {
    console.warn('sendTyping failed', {
      context,
      details: describeError(error),
    })
  }
}

async function trySend({
  target,
  payload,
  context,
}: {
  target: EchoReplyTarget
  payload: Parameters<EchoReplyTarget['send']>[0]
  context: string
}): Promise<boolean> {
  try {
    await target.send(payload)
    return true
  } catch (error) {
    console.warn('send failed', {
      context,
      details: describeError(error),
    })
    return false
  }
}

type EchoReplyTarget = Pick<ThreadChannel, 'send' | 'sendTyping'>

function describeError(error: unknown): {
  name: string
  message: string
  stack?: string
  status?: number
  method?: string
  url?: string
  rawErrorText?: string
} {
  if (!(error instanceof Error)) {
    return {
      name: 'UnknownError',
      message: String(error),
    }
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    status: readNumberProp({ value: error, key: 'status' }),
    method: readStringProp({ value: error, key: 'method' }),
    url: readStringProp({ value: error, key: 'url' }),
    rawErrorText: decodeRawErrorText(error),
  }
}

function readStringProp({
  value,
  key,
}: {
  value: object
  key: string
}): string | undefined {
  if (!(key in value)) {
    return undefined
  }
  const raw = Reflect.get(value, key)
  if (typeof raw === 'string') {
    return raw
  }
  return undefined
}

function readNumberProp({
  value,
  key,
}: {
  value: object
  key: string
}): number | undefined {
  if (!(key in value)) {
    return undefined
  }
  const raw = Reflect.get(value, key)
  if (typeof raw === 'number') {
    return raw
  }
  return undefined
}

function decodeRawErrorText(error: Error): string | undefined {
  if (!('rawError' in error)) {
    return undefined
  }
  const raw = Reflect.get(error, 'rawError')
  if (typeof raw === 'string') {
    return raw
  }
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(raw)
  }
  return undefined
}

function createDemoImageAttachment(): AttachmentBuilder {
  const imageBuffer = fs.readFileSync(DEMO_IMAGE_FILE_URL)
  return new AttachmentBuilder(imageBuffer, {
    name: 'demo-image.jpeg',
  })
}

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
  try {
    return await createThreadForChannelMessage({ message, threadName })
  } catch (error) {
    console.warn('thread creation failed, falling back to channel reply', {
      context: 'resolveReplyThread',
      details: describeError(error),
    })
    return undefined
  }
}

async function resolveReplyThreadFromInteraction({
  interaction,
}: {
  interaction: ChatInputCommandInteraction
}): Promise<ThreadChannel | undefined> {
  if (interaction.channel?.isThread()) {
    return interaction.channel
  }

  if (!(interaction.channel && 'threads' in interaction.channel)) {
    return undefined
  }

  const threadName = `echo-${interaction.user.username}`.slice(0, 100)
  return interaction.channel.threads.create({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
  })
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
