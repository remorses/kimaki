// Discord adapter for Kimaki's platform interface.
// Owns discord.js client lifecycle, inbound event normalization, thread/message
// operations, and Discord-specific markdown splitting/rendering.

import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type InteractionDeferReplyOptions,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  MessageFlags,
  type ModalSubmitInteraction,
  ModalBuilder,
  FileUploadBuilder,
  LabelBuilder,
  Partials,
  Routes,
  type Message,
  type StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type TextChannel,
  ThreadChannel,
} from 'discord.js'
import type {
  AutocompleteEvent,
  ButtonEvent,
  CommandEvent,
  IncomingMessageEvent,
  IncomingThreadEvent,
  KimakiAdapter,
  MessageAccess,
  LegacyEditReplyOptions,
  LegacyReplyOptions,
  LegacyUpdateOptions,
  ModalSubmitEvent,
  PlatformChannel,
  MessageTarget,
  OutgoingMessage,
  PlatformMessage,
  PlatformThread,
  SelectMenuEvent,
  UiButton,
  UiButtonStyle,
  UiModal,
  UiSelectMenu,
} from './types.js'
import { getDiscordRestApiUrl } from '../discord-urls.js'
import {
  escapeBackticksInCodeBlocks,
  hasKimakiBotPermission,
  hasNoKimakiRole,
  splitMarkdownForDiscord,
} from '../discord-utils.js'
import { splitTablesFromMarkdown } from '../format-tables.js'
import { limitHeadingDepth } from '../limit-heading-depth.js'
import { unnestCodeBlocksFromLists } from '../unnest-code-blocks.js'
import {
  getFileAttachments,
  getTextAttachments,
  resolveMentions,
} from '../message-formatting.js'
import { processVoiceAttachment } from '../voice-handler.js'

type DiscordTextTarget = TextChannel | ThreadChannel

function normalizeReplyOptions(
  options: LegacyReplyOptions,
): string | InteractionReplyOptions {
  return options
}

function normalizeEditReplyOptions(
  options: LegacyEditReplyOptions,
): string | InteractionEditReplyOptions {
  return options
}

function normalizeUpdateOptions(
  options: LegacyUpdateOptions,
): string | InteractionUpdateOptions {
  return options
}

function buildInteractionUiMessage(message: OutgoingMessage) {
  return {
    content: message.markdown,
    flags: message.flags,
    components: buildMessageComponents({
      buttons: message.buttons,
      selectMenu: message.selectMenu,
      selectMenus: message.selectMenus,
    }),
  }
}

function buildButtonStyle(style?: UiButtonStyle): ButtonStyle {
  if (style === 'primary') {
    return ButtonStyle.Primary
  }
  if (style === 'success') {
    return ButtonStyle.Success
  }
  if (style === 'danger') {
    return ButtonStyle.Danger
  }
  if (style === 'link') {
    return ButtonStyle.Link
  }
  return ButtonStyle.Secondary
}

function isTruthy<T>(value: T): value is NonNullable<T> {
  return Boolean(value)
}

function buildMessageComponents({
  buttons,
  selectMenu,
  selectMenus,
}: {
  buttons?: UiButton[]
  selectMenu?: UiSelectMenu
  selectMenus?: UiSelectMenu[]
}) {
  const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = []
  if (buttons && buttons.length > 0) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...buttons.map((button) => {
        const style = button.style === 'link' ? 'secondary' : button.style
        return new ButtonBuilder()
          .setCustomId(button.id)
          .setLabel(button.label)
          .setStyle(buildButtonStyle(style))
      }),
    )
    components.push(row as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>)
  }
  const allSelectMenus = [selectMenu, ...(selectMenus || [])].filter(isTruthy)
  for (const currentSelectMenu of allSelectMenus) {
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(currentSelectMenu.id)
        .setPlaceholder(currentSelectMenu.placeholder || 'Select an option')
        .addOptions(currentSelectMenu.options)
        .setMinValues(currentSelectMenu.minValues ?? 1)
        .setMaxValues(currentSelectMenu.maxValues ?? 1),
    )
    components.push(row as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>)
  }
  return components
}

function wrapMessage(message: Message): PlatformMessage {
  return {
    id: message.id,
    content: message.content,
    channelId: message.channelId,
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.member?.displayName || message.author.displayName,
      bot: message.author.bot,
    },
    attachments: message.attachments,
    embeds: message.embeds.map((embed) => {
      return {
        data: {
          footer: {
            text: embed.footer?.text,
          },
        },
      }
    }),
    raw: message,
  }
}

function wrapThread(thread: ThreadChannel): PlatformThread {
  return {
    id: thread.id,
    name: thread.name,
    parentId: thread.parentId,
    guildId: thread.guildId,
    createdTimestamp: thread.createdTimestamp ?? null,
    raw: thread,
  }
}

function wrapChannel(channel: TextChannel | ThreadChannel): PlatformChannel {
  if (channel instanceof ThreadChannel) {
    return {
      id: channel.id,
      name: channel.name,
      kind: 'thread',
      raw: channel,
    }
  }
  return {
    id: channel.id,
    name: channel.name,
    kind: 'text',
    topic: channel.topic,
    raw: channel,
  }
}

function unwrapDiscordMessage(message: PlatformMessage): Message {
  if (!(message.raw instanceof Object)) {
    throw new Error('Platform message is missing Discord raw message')
  }
  return message.raw as Message
}

function unwrapDiscordThread(thread: PlatformThread): ThreadChannel {
  if (!(thread.raw instanceof ThreadChannel)) {
    throw new Error('Platform thread is missing Discord raw thread')
  }
  return thread.raw
}

function buildDiscordModal(modal: UiModal) {
  const built = new ModalBuilder().setCustomId(modal.id).setTitle(modal.title)
  for (const input of modal.inputs) {
    if (input.type === 'text') {
      const row = new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(input.id)
          .setLabel(input.label)
          .setPlaceholder(input.placeholder || '')
          .setRequired(input.required ?? true)
          .setStyle(
            input.style === 'paragraph'
              ? TextInputStyle.Paragraph
              : TextInputStyle.Short,
          ),
      )
      built.addComponents(row)
      continue
    }
    const fileUpload = new FileUploadBuilder()
      .setCustomId(input.id)
      .setMinValues(input.minFiles ?? 1)
      .setMaxValues(input.maxFiles ?? 1)
    const label = new LabelBuilder()
      .setLabel(input.label)
      .setDescription(input.description || '')
      .setFileUploadComponent(fileUpload)
    built.addLabelComponents(label)
  }
  return built
}

export async function createDiscordClient() {
  const restApiUrl = getDiscordRestApiUrl()
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
    rest: { api: restApiUrl },
  })
}

export class DiscordAdapter implements KimakiAdapter {
  readonly name = 'discord'
  readonly client: Client

  constructor({ client }: { client: Client }) {
    this.client = client
  }

  async login(token: string) {
    await this.client.login(token)
  }

  destroy() {
    this.client.destroy()
  }

  private async getTargetChannel(
    target: MessageTarget,
  ): Promise<DiscordTextTarget> {
    const targetId = target.threadId || target.channelId
    const cached = this.client.channels.cache.get(targetId)
    const channel = cached || (await this.client.channels.fetch(targetId))
    if (!channel) {
      throw new Error(`Channel not found: ${targetId}`)
    }
    if (channel.type === ChannelType.GuildText) {
      return channel
    }
    if (
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread
    ) {
      return channel
    }
    throw new Error(`Channel ${targetId} is not a sendable text target`)
  }

  private async getMessageTarget(
    target: MessageTarget,
    messageId: string,
  ): Promise<Message> {
    const channel = await this.getTargetChannel(target)
    return channel.messages.fetch(messageId)
  }

  private async sendMarkdownSegments(
    channel: DiscordTextTarget,
    message: OutgoingMessage,
  ): Promise<{ id: string }> {
    const segments = splitTablesFromMarkdown(message.markdown)
    const baseFlags = message.flags ?? 0
    let firstMessage: Message | undefined
    let shouldReply = true

    for (const segment of segments) {
      if (segment.type === 'components') {
        const sent = await channel.send({
          components: segment.components,
          flags: MessageFlags.IsComponentsV2 | baseFlags,
          reply: shouldReply && message.replyToMessageId
            ? { messageReference: message.replyToMessageId }
            : undefined,
        })
        if (!firstMessage) {
          firstMessage = sent
        }
        shouldReply = false
        continue
      }

      let text = segment.text
      text = unnestCodeBlocksFromLists(text)
      text = limitHeadingDepth(text)
      text = escapeBackticksInCodeBlocks(text)

      if (!text.trim()) {
        continue
      }

      const chunks = splitMarkdownForDiscord({
        content: text,
        maxLength: 2000,
      })

      for (let chunk of chunks) {
        if (!chunk) {
          continue
        }
        if (chunk.length > 2000) {
          chunk = chunk.slice(0, 1996) + '...'
        }
        const sent = await channel.send({
          content: chunk,
          flags: baseFlags,
          reply: shouldReply && message.replyToMessageId
            ? { messageReference: message.replyToMessageId }
            : undefined,
        })
        if (!firstMessage) {
          firstMessage = sent
        }
        shouldReply = false
      }
    }

    if (!firstMessage) {
      const sent = await channel.send({
        content: '\u200b',
        flags: baseFlags,
        reply: message.replyToMessageId
          ? { messageReference: message.replyToMessageId }
          : undefined,
      })
      firstMessage = sent
    }

    return { id: firstMessage.id }
  }

  async sendMessage(target: MessageTarget, message: OutgoingMessage) {
    const channel = await this.getTargetChannel(target)
    if (message.buttons || message.selectMenu || message.selectMenus) {
      const sent = await channel.send({
        content: message.markdown.slice(0, 2000),
        flags: message.flags,
        components: buildMessageComponents({
          buttons: message.buttons,
          selectMenu: message.selectMenu,
          selectMenus: message.selectMenus,
        }),
        reply: message.replyToMessageId
          ? { messageReference: message.replyToMessageId }
          : undefined,
      })
      return { id: sent.id }
    }
    return this.sendMarkdownSegments(channel, message)
  }

  async updateMessage(
    target: MessageTarget,
    messageId: string,
    message: OutgoingMessage,
  ) {
    const targetMessage = await this.getMessageTarget(target, messageId)
    await targetMessage.edit({
      content: message.markdown,
      flags: message.flags,
      components: message.buttons || message.selectMenu || message.selectMenus
        ? buildMessageComponents({
            buttons: message.buttons,
            selectMenu: message.selectMenu,
            selectMenus: message.selectMenus,
          })
        : [],
    })
  }

  async deleteMessage(target: MessageTarget, messageId: string) {
    const targetMessage = await this.getMessageTarget(target, messageId)
    await targetMessage.delete()
  }

  async fetchMessage(target: MessageTarget, messageId: string) {
    return wrapMessage(await this.getMessageTarget(target, messageId))
  }

  async fetchChannel(channelId: string): Promise<PlatformChannel | null> {
    const cached = this.client.channels.cache.get(channelId)
    const channel = cached || (await this.client.channels.fetch(channelId))
    if (!channel) {
      return null
    }
    if (channel.type === ChannelType.GuildText) {
      return wrapChannel(channel)
    }
    if (
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread
    ) {
      return wrapChannel(channel)
    }
    return {
      id: channel.id,
      kind: 'other' as const,
      raw: channel,
    }
  }

  async startTyping(target: MessageTarget) {
    const channel = await this.getTargetChannel(target)
    await channel.sendTyping()
  }

  async renameThread(threadId: string, name: string) {
    const channel = await this.getTargetChannel({ channelId: threadId, threadId })
    if (!(channel instanceof ThreadChannel)) {
      throw new Error('renameThread requires a thread target')
    }
    await channel.setName(name)
  }

  formatThreadReference(thread: PlatformThread) {
    return `<#${thread.id}>`
  }

  async resolveMentions(message: PlatformMessage) {
    return resolveMentions(unwrapDiscordMessage(message))
  }

  async getTextAttachments(message: PlatformMessage) {
    return getTextAttachments(unwrapDiscordMessage(message))
  }

  async getFileAttachments(message: PlatformMessage) {
    return getFileAttachments(unwrapDiscordMessage(message))
  }

  async getMessageAccess(message: PlatformMessage): Promise<MessageAccess> {
    const discordMessage = unwrapDiscordMessage(message)
    if (hasNoKimakiRole(discordMessage.member)) {
      return 'blocked'
    }
    if (!hasKimakiBotPermission(discordMessage.member)) {
      return 'denied'
    }
    return 'allowed'
  }

  async processVoiceAttachment(input: {
    message: PlatformMessage
    thread: PlatformThread
    projectDirectory?: string
    isNewThread?: boolean
    appId?: string
    currentSessionContext?: string
    lastSessionContext?: string
  }) {
    return processVoiceAttachment({
      adapter: this,
      message: input.message,
      thread: input.thread,
      projectDirectory: input.projectDirectory,
      isNewThread: input.isNewThread,
      appId: input.appId,
      currentSessionContext: input.currentSessionContext,
      lastSessionContext: input.lastSessionContext,
    })
  }

  async createThreadFromMessage(input: {
    message: PlatformMessage
    name: string
    autoArchiveDuration: number
    reason: string
  }) {
    const message = unwrapDiscordMessage(input.message)
    const thread = await message.startThread({
      name: input.name,
      autoArchiveDuration: input.autoArchiveDuration,
      reason: input.reason,
    })
    return {
      thread: wrapThread(thread),
      target: {
        channelId: thread.parentId || thread.id,
        threadId: thread.id,
      },
    }
  }

  async createThread(input: {
    channelId: string
    messageId: string
    name: string
    autoArchiveDuration: number
    reason: string
  }) {
    const message = await this.getMessageTarget(
      { channelId: input.channelId },
      input.messageId,
    )
    return this.createThreadFromMessage({
      message: wrapMessage(message),
      name: input.name,
      autoArchiveDuration: input.autoArchiveDuration,
      reason: input.reason,
    })
  }

  async addThreadMember(threadId: string, userId: string) {
    const channel = await this.getTargetChannel({ channelId: threadId, threadId })
    if (!(channel instanceof ThreadChannel)) {
      throw new Error('addThreadMember requires a thread target')
    }
    await channel.members.add(userId)
  }

  async addThreadStarterReaction(
    input: { channelId: string; threadId: string },
    emoji: string,
  ) {
    await this.client.rest.put(
      Routes.channelMessageOwnReaction(
        input.channelId,
        input.threadId,
        encodeURIComponent(emoji),
      ),
    )
  }

  async fetchStarterMessage(threadId: string) {
    const channel = await this.getTargetChannel({ channelId: threadId, threadId })
    if (!(channel instanceof ThreadChannel)) {
      return null
    }
    const starter = await channel.fetchStarterMessage().catch(() => {
      return null
    })
    if (!starter) {
      return null
    }
    return wrapMessage(starter)
  }

  onReady(handler: () => void) {
    this.client.on(Events.ClientReady, () => {
      void handler()
    })
  }

  onMessage(handler: (event: IncomingMessageEvent) => void | Promise<void>) {
    this.client.on(Events.MessageCreate, async (message) => {
      const normalizedMessage = message.partial
        ? await message.fetch().catch(() => {
            return null
          })
        : message
      if (!normalizedMessage) {
        return
      }
      const isThread = normalizedMessage.channel.isThread()
      const channelId = (() => {
        if (normalizedMessage.channel.isThread()) {
          return normalizedMessage.channel.parentId || normalizedMessage.channel.id
        }
        return normalizedMessage.channel.id
      })()
      const target = isThread
        ? {
            channelId,
            threadId: normalizedMessage.channel.id,
          }
        : { channelId }
      const isMention = Boolean(
        this.client.user && normalizedMessage.mentions.has(this.client.user.id),
      )
      void handler({
        message: wrapMessage(normalizedMessage),
        thread: isThread
          ? wrapThread(normalizedMessage.channel as ThreadChannel)
          : undefined,
        target,
        kind: isThread ? 'thread' : 'channel',
        isMention,
        isSelf: Boolean(
          this.client.user && normalizedMessage.author.id === this.client.user.id,
        ),
      })
    })
  }

  onThreadCreate(
    handler: (event: IncomingThreadEvent) => void | Promise<void>,
  ) {
    this.client.on(Events.ThreadCreate, (thread, newlyCreated) => {
      void handler({
        thread: wrapThread(thread),
        newlyCreated,
        target: {
          channelId: thread.parentId || thread.id,
          threadId: thread.id,
        },
      })
    })
  }

  onThreadDelete(handler: (threadId: string) => void) {
    this.client.on(Events.ThreadDelete, (thread) => {
      handler(thread.id)
    })
  }

  private wrapCommandEvent({
    interaction,
    appId,
  }: {
    interaction: ChatInputCommandInteraction
    appId: string
  }): CommandEvent {
    return {
      raw: interaction,
      appId,
      commandName: interaction.commandName,
      commandId: interaction.commandId,
      client: interaction.client,
      channel: interaction.channel,
      channelId: interaction.channelId,
      guild: interaction.guild,
      guildId: interaction.guildId,
      member: interaction.member,
      user: interaction.user,
      options: interaction.options,
      command: interaction.command,
      deferred: interaction.deferred,
      replied: interaction.replied,
      reply: async (options) => {
        await interaction.reply(normalizeReplyOptions(options))
      },
      replyUi: async (message) => {
        await interaction.reply(buildInteractionUiMessage(message))
      },
      deferReply: async (options?: InteractionDeferReplyOptions) => {
        await interaction.deferReply(options)
      },
      editReply: async (options) => {
        await interaction.editReply(normalizeEditReplyOptions(options))
      },
      editUiReply: async (message) => {
        await interaction.editReply(buildInteractionUiMessage(message))
      },
      showModal: async (modal) => {
        await interaction.showModal(buildDiscordModal(modal))
      },
    }
  }

  private wrapAutocompleteEvent({
    interaction,
    appId,
  }: {
    interaction: AutocompleteInteraction
    appId: string
  }): AutocompleteEvent {
    return {
      raw: interaction,
      appId,
      commandName: interaction.commandName,
      channel: interaction.channel,
      channelId: interaction.channelId,
      guild: interaction.guild,
      guildId: interaction.guildId,
      member: interaction.member,
      user: interaction.user,
      options: interaction.options,
      respond: async (options) => {
        await interaction.respond(options)
      },
    }
  }

  private wrapButtonEvent({
    interaction,
    appId,
  }: {
    interaction: ButtonInteraction
    appId: string
  }): ButtonEvent {
    return {
      raw: interaction,
      appId,
      customId: interaction.customId,
      client: interaction.client,
      channel: interaction.channel,
      channelId: interaction.channelId,
      guild: interaction.guild,
      guildId: interaction.guildId,
      member: interaction.member,
      user: interaction.user,
      message: interaction.message,
      deferred: interaction.deferred,
      replied: interaction.replied,
      reply: async (options) => {
        await interaction.reply(normalizeReplyOptions(options))
      },
      replyUi: async (message) => {
        await interaction.reply(buildInteractionUiMessage(message))
      },
      deferReply: async (options?: InteractionDeferReplyOptions) => {
        await interaction.deferReply(options)
      },
      editReply: async (options) => {
        await interaction.editReply(normalizeEditReplyOptions(options))
      },
      editUiReply: async (message) => {
        await interaction.editReply(buildInteractionUiMessage(message))
      },
      followUp: async (options) => {
        await interaction.followUp(options)
      },
      deferUpdate: async (options?: { withResponse?: boolean }) => {
        await interaction.deferUpdate(options)
      },
      update: async (options) => {
        await interaction.update(normalizeUpdateOptions(options))
      },
      updateUi: async (message) => {
        await interaction.update(buildInteractionUiMessage(message))
      },
      showModal: async (modal) => {
        await interaction.showModal(buildDiscordModal(modal))
      },
    }
  }

  private wrapSelectMenuEvent({
    interaction,
    appId,
  }: {
    interaction: StringSelectMenuInteraction
    appId: string
  }): SelectMenuEvent {
    return {
      raw: interaction,
      appId,
      customId: interaction.customId,
      client: interaction.client,
      channel: interaction.channel,
      channelId: interaction.channelId,
      guild: interaction.guild,
      guildId: interaction.guildId,
      member: interaction.member,
      user: interaction.user,
      message: interaction.message,
      values: [...interaction.values],
      deferred: interaction.deferred,
      replied: interaction.replied,
      reply: async (options) => {
        await interaction.reply(normalizeReplyOptions(options))
      },
      replyUi: async (message) => {
        await interaction.reply(buildInteractionUiMessage(message))
      },
      deferReply: async (options?: InteractionDeferReplyOptions) => {
        await interaction.deferReply(options)
      },
      editReply: async (options) => {
        await interaction.editReply(normalizeEditReplyOptions(options))
      },
      editUiReply: async (message) => {
        await interaction.editReply(buildInteractionUiMessage(message))
      },
      deferUpdate: async (options?: { withResponse?: boolean }) => {
        await interaction.deferUpdate(options)
      },
      update: async (options) => {
        await interaction.update(normalizeUpdateOptions(options))
      },
      updateUi: async (message) => {
        await interaction.update(buildInteractionUiMessage(message))
      },
      showModal: async (modal) => {
        await interaction.showModal(buildDiscordModal(modal))
      },
    }
  }

  private wrapModalSubmitEvent({
    interaction,
    appId,
  }: {
    interaction: ModalSubmitInteraction
    appId: string
  }): ModalSubmitEvent {
    return {
      raw: interaction,
      appId,
      customId: interaction.customId,
      client: interaction.client,
      channel: interaction.channel,
      channelId: interaction.channelId,
      guild: interaction.guild,
      guildId: interaction.guildId,
      member: interaction.member,
      user: interaction.user,
      fields: interaction.fields,
      deferred: interaction.deferred,
      replied: interaction.replied,
      reply: async (options) => {
        await interaction.reply(normalizeReplyOptions(options))
      },
      replyUi: async (message) => {
        await interaction.reply(buildInteractionUiMessage(message))
      },
      deferReply: async (options?: InteractionDeferReplyOptions) => {
        await interaction.deferReply(options)
      },
      editReply: async (options) => {
        await interaction.editReply(normalizeEditReplyOptions(options))
      },
      editUiReply: async (message) => {
        await interaction.editReply(buildInteractionUiMessage(message))
      },
    }
  }

  onCommand(handler: (event: CommandEvent) => void | Promise<void>) {
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return
      }
      const appId = this.client.application?.id
      if (!appId) {
        return
      }
      void handler(this.wrapCommandEvent({ interaction, appId }))
    })
  }

  onAutocomplete(handler: (event: AutocompleteEvent) => void | Promise<void>) {
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isAutocomplete()) {
        return
      }
      const appId = this.client.application?.id
      if (!appId) {
        return
      }
      void handler(this.wrapAutocompleteEvent({ interaction, appId }))
    })
  }

  onButton(handler: (event: ButtonEvent) => void | Promise<void>) {
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isButton()) {
        return
      }
      const appId = this.client.application?.id
      if (!appId) {
        return
      }
      void handler(this.wrapButtonEvent({ interaction, appId }))
    })
  }

  onSelectMenu(handler: (event: SelectMenuEvent) => void | Promise<void>) {
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isStringSelectMenu()) {
        return
      }
      const appId = this.client.application?.id
      if (!appId) {
        return
      }
      void handler(this.wrapSelectMenuEvent({ interaction, appId }))
    })
  }

  onModalSubmit(handler: (event: ModalSubmitEvent) => void | Promise<void>) {
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isModalSubmit()) {
        return
      }
      const appId = this.client.application?.id
      if (!appId) {
        return
      }
      void handler(this.wrapModalSubmitEvent({ interaction, appId }))
    })
  }

  onError(handler: (error: Error) => void) {
    this.client.on(Events.Error, handler)
  }
}

export async function createDiscordAdapter({
  client,
}: {
  client?: Client
} = {}) {
  const resolvedClient = client || (await createDiscordClient())
  return new DiscordAdapter({ client: resolvedClient })
}
