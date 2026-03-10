// Discord adapter for Kimaki's platform interface.
// Owns discord.js client lifecycle, inbound event normalization, thread/message
// operations, and Discord-specific markdown splitting/rendering.

import {
  ActionRowBuilder,
  type APIInteractionGuildMember,
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
  type Guild,
  GuildMember,
  type ModalSubmitInteraction,
  type Attachment,
  ModalBuilder,
  FileUploadBuilder,
  LabelBuilder,
  Partials,
  PermissionsBitField,
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
  PlatformChannelHandle,
  PlatformConversation,
  PlatformConversationMessage,
  PlatformDeferReplyOptions,
  PlatformFileAttachment,
  PlatformGuildSummary,
  MessageTarget,
  OutgoingMessage,
  PlatformMessage,
  PlatformModalFields,
  PlatformAdmin,
  PlatformServer,
  PlatformThread,
  PlatformThreadHandle,
  PlatformUser,
  SelectMenuEvent,
  UiButton,
  UiButtonStyle,
  UiModal,
  PlatformCommandOptions,
  PlatformUploadedFile,
  UiSelectMenu,
} from './types.js'
import { getDiscordRestApiUrl } from '../discord-urls.js'
import {
  escapeBackticksInCodeBlocks,
  splitMarkdownForDiscord,
} from '../discord-utils.js'
import { splitTablesFromMarkdown } from '../format-tables.js'
import { limitHeadingDepth } from '../limit-heading-depth.js'
import { unnestCodeBlocksFromLists } from '../unnest-code-blocks.js'
import { isTextMimeType } from '../message-formatting.js'
import { createLogger, LogPrefix } from '../logger.js'
import { processImage } from '../image-utils.js'
import { FetchError } from '../errors.js'
import * as errore from 'errore'
import { processVoiceAttachment } from '../voice-handler.js'
import { handleHtmlActionButton } from '../html-actions.js'

// ── Permission helpers (discord.js-specific, used by adapter + voice-handler) ──

/**
 * Check if a guild member has permission to use the Kimaki bot.
 * Returns true for: server owner, Administrator, Manage Server, or "Kimaki" role.
 * Returns false if member has the "no-kimaki" role (overrides all).
 */
export function hasKimakiBotPermission(
  member: GuildMember | APIInteractionGuildMember | null,
  guild?: Guild | null,
): boolean {
  if (!member) {
    return false
  }
  if (hasRoleByName(member, 'no-kimaki', guild)) {
    return false
  }
  const memberPermissions =
    member instanceof GuildMember
      ? member.permissions
      : new PermissionsBitField(BigInt(member.permissions))
  const ownerId = member instanceof GuildMember ? member.guild.ownerId : guild?.ownerId
  const memberId = member instanceof GuildMember ? member.id : member.user.id
  const isOwner = ownerId ? memberId === ownerId : false
  const isAdmin = memberPermissions.has(PermissionsBitField.Flags.Administrator)
  const canManageServer = memberPermissions.has(PermissionsBitField.Flags.ManageGuild)
  const hasKimakiRole = hasRoleByName(member, 'kimaki', guild)
  return isOwner || isAdmin || canManageServer || hasKimakiRole
}

function hasRoleByName(
  member: GuildMember | APIInteractionGuildMember,
  roleName: string,
  guild?: Guild | null,
): boolean {
  const target = roleName.toLowerCase()

  if (member instanceof GuildMember) {
    return member.roles.cache.some((role) => role.name.toLowerCase() === target)
  }

  if (!guild) {
    return false
  }

  const roleIds = Array.isArray(member.roles) ? member.roles : []
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId)
    if (role?.name.toLowerCase() === target) {
      return true
    }
  }
  return false
}

/**
 * Check if the member has the "no-kimaki" role that blocks bot access.
 */
export function hasNoKimakiRole(member: GuildMember | null): boolean {
  if (!member?.roles?.cache) {
    return false
  }
  return member.roles.cache.some(
    (role) => role.name.toLowerCase() === 'no-kimaki',
  )
}

// ── Discord message content helpers (discord.js-specific) ──────────────

const contentLogger = createLogger(LogPrefix.FORMATTING)

function resolveMentions(message: Message): string {
  let content = message.content || ''
  for (const [userId, user] of message.mentions.users) {
    const member = message.guild?.members.cache.get(userId)
    const displayName = member?.displayName || user.displayName || user.username
    content = content.replace(
      new RegExp(`<@!?${userId}>`, 'g'),
      `@${displayName}`,
    )
  }
  for (const [roleId, role] of message.mentions.roles) {
    content = content.replace(new RegExp(`<@&${roleId}>`, 'g'), `@${role.name}`)
  }
  for (const [channelId, channel] of message.mentions.channels) {
    const name = 'name' in channel ? (channel as TextChannel).name : channelId
    content = content.replace(new RegExp(`<#${channelId}>`, 'g'), `#${name}`)
  }
  return content
}

async function getTextAttachments(message: Message): Promise<string> {
  const textAttachments = Array.from(message.attachments.values()).filter(
    (attachment) => isTextMimeType(attachment.contentType),
  )
  if (textAttachments.length === 0) {
    return ''
  }
  const textContents = await Promise.all(
    textAttachments.map(async (attachment) => {
      const response = await errore.tryAsync({
        try: () => fetch(attachment.url),
        catch: (e) => new FetchError({ url: attachment.url, cause: e }),
      })
      if (response instanceof Error) {
        return `<attachment filename="${attachment.name}" error="${response.message}" />`
      }
      if (!response.ok) {
        return `<attachment filename="${attachment.name}" error="Failed to fetch: ${response.status}" />`
      }
      const text = await response.text()
      return `<attachment filename="${attachment.name}" mime="${attachment.contentType}">\n${text}\n</attachment>`
    }),
  )
  return textContents.join('\n\n')
}

async function getFileAttachments(
  message: Message,
): Promise<PlatformFileAttachment[]> {
  const fileAttachments = Array.from(message.attachments.values()).filter(
    (attachment) => {
      const contentType = attachment.contentType || ''
      return (
        contentType.startsWith('image/') || contentType === 'application/pdf'
      )
    },
  )
  if (fileAttachments.length === 0) {
    return []
  }
  const results = await Promise.all(
    fileAttachments.map(async (attachment) => {
      const response = await errore.tryAsync({
        try: () => fetch(attachment.url),
        catch: (e) => new FetchError({ url: attachment.url, cause: e }),
      })
      if (response instanceof Error) {
        contentLogger.error(
          `Error downloading attachment ${attachment.name}:`,
          response.message,
        )
        return null
      }
      if (!response.ok) {
        contentLogger.error(
          `Failed to fetch attachment ${attachment.name}: ${response.status}`,
        )
        return null
      }
      const rawBuffer = Buffer.from(await response.arrayBuffer())
      const originalMime = attachment.contentType || 'application/octet-stream'
      const { buffer, mime } = await processImage(rawBuffer, originalMime)
      const base64 = buffer.toString('base64')
      const dataUrl = `data:${mime};base64,${base64}`
      contentLogger.log(
        `Attachment ${attachment.name}: ${rawBuffer.length} → ${buffer.length} bytes, ${mime}`,
      )
      return {
        type: 'file' as const,
        mime,
        filename: attachment.name,
        url: dataUrl,
        sourceUrl: attachment.url,
      }
    }),
  )
  return results.filter(isTruthy)
}

type DiscordTextTarget = TextChannel | ThreadChannel

const discordMessageStore = new Map<string, Message>()
const discordGuildStore = new Map<string, Guild>()

function getDiscordMessageStoreKey({
  channelId,
  messageId,
}: {
  channelId: string
  messageId: string
}) {
  return `${channelId}:${messageId}`
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

function wrapUser({
  user,
  displayName,
}: {
  user: Message['author'] | ChatInputCommandInteraction['user']
  displayName?: string | null
}): PlatformUser {
  return {
    id: user.id,
    username: user.username,
    displayName: displayName || user.displayName || user.username,
    globalName: user.displayName || undefined,
    bot: user.bot,
  }
}

function wrapMessage(message: Message): PlatformMessage {
  discordMessageStore.set(
    getDiscordMessageStoreKey({ channelId: message.channelId, messageId: message.id }),
    message,
  )
  return {
    id: message.id,
    content: message.content,
    channelId: message.channelId,
    author: wrapUser({ user: message.author, displayName: message.member?.displayName }),
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
  }
}

function wrapThread(thread: ThreadChannel): PlatformThread {
  return {
    id: thread.id,
    name: thread.name,
    kind: 'thread',
    type: 'thread',
    parentId: thread.parentId,
    guildId: thread.guildId,
    createdTimestamp: thread.createdTimestamp ?? null,
    isThread() {
      return true
    },
  }
}

function wrapChannel(channel: TextChannel | ThreadChannel): PlatformChannel {
  if (channel instanceof ThreadChannel) {
      return {
        id: channel.id,
        name: channel.name,
        kind: 'thread',
        type: 'thread',
        parentId: channel.parentId,
        guildId: channel.guildId,
        createdTimestamp: channel.createdTimestamp ?? null,
        isThread() {
          return true
        },
      }
  }
  return {
    id: channel.id,
    name: channel.name,
    kind: 'text',
    type: 'text',
    parentId: null,
    guildId: channel.guildId,
    topic: channel.topic,
    isThread() {
      return false
    },
  }
}

function wrapOtherChannel({
  id,
  guildId,
  name,
  parentId,
}: {
  id: string
  guildId?: string | null
  name?: string
  parentId?: string | null
}): PlatformChannel {
  return {
    id,
    name,
    kind: 'other',
    type: 'other',
    parentId: parentId || null,
    guildId: guildId || null,
    isThread() {
      return false
    },
  }
}

function wrapOptionalChannel(channel: ChatInputCommandInteraction['channel']): PlatformChannel | null {
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
  return wrapOtherChannel({
    id: channel.id,
    guildId: 'guildId' in channel ? channel.guildId || null : null,
    name: 'name' in channel ? channel.name || undefined : undefined,
    parentId: 'parentId' in channel ? channel.parentId : null,
  })
}

function getInteractionDisplayName({
  member,
  user,
}: {
  member: ChatInputCommandInteraction['member'] | ButtonInteraction['member'] | StringSelectMenuInteraction['member'] | ModalSubmitInteraction['member'] | AutocompleteInteraction['member']
  user: ChatInputCommandInteraction['user']
}): string {
  if (member instanceof Object && 'displayName' in member && typeof member.displayName === 'string') {
    return member.displayName
  }
  return user.displayName || user.username
}

function getInteractionAccess({
  member,
  guild,
}: {
  member: ChatInputCommandInteraction['member'] | ButtonInteraction['member'] | StringSelectMenuInteraction['member'] | ModalSubmitInteraction['member'] | AutocompleteInteraction['member']
  guild: Guild | null
}) {
  const canUseKimaki = member && 'permissions' in member && !Array.isArray(member.roles)
    ? hasKimakiBotPermission(member, guild)
    : false
  const isBlocked = member instanceof GuildMember
    ? hasNoKimakiRole(member)
    : false
  return {
    canUseKimaki,
    isBlocked,
  }
}

function wrapServer({
  guild,
}: {
  guild: Guild | null
}): PlatformServer | null {
  if (!guild) {
    return null
  }
  discordGuildStore.set(guild.id, guild)
  return {
    id: guild.id,
    name: guild.name,
  }
}

function wrapGuildMemberSummary(member: GuildMember) {
  return {
    id: member.user.id,
    username: member.user.username,
    globalName: member.user.globalName || undefined,
    nick: member.nickname || undefined,
  }
}

function createCommandOptions({
  interaction,
}: {
  interaction: ChatInputCommandInteraction | AutocompleteInteraction
}): PlatformCommandOptions {
  return {
    getString(name: string, required?: boolean) {
      return interaction.options.getString(name, required ?? false) || ''
    },
    getFocused(withMeta?: true) {
      if (withMeta && 'respond' in interaction) {
        const focused = interaction.options.getFocused(true)
        return {
          name: focused.name,
          value: String(focused.value),
        }
      }
      if ('respond' in interaction) {
        return String(interaction.options.getFocused())
      }
      return ''
    },
  }
}

function normalizeReplyOptions(
  options: LegacyReplyOptions,
): string | InteractionReplyOptions {
  if (typeof options === 'string') {
    return options
  }
  return options as InteractionReplyOptions
}

function normalizeEditReplyOptions(
  options: LegacyEditReplyOptions,
): string | InteractionEditReplyOptions {
  if (typeof options === 'string') {
    return options
  }
  return options as InteractionEditReplyOptions
}

function normalizeUpdateOptions(
  options: LegacyUpdateOptions,
): string | InteractionUpdateOptions {
  if (typeof options === 'string') {
    return options
  }
  return options as InteractionUpdateOptions
}

function normalizeDeferReplyOptions(
  options?: PlatformDeferReplyOptions,
): InteractionDeferReplyOptions | undefined {
  if (!options) {
    return undefined
  }
  if (options.flags !== undefined) {
    return { flags: options.flags }
  }
  if (options.ephemeral !== undefined) {
    return { flags: options.ephemeral ? MessageFlags.Ephemeral : undefined }
  }
  return undefined
}

function createModalFields({
  interaction,
}: {
  interaction: ModalSubmitInteraction
}): PlatformModalFields {
  return {
    getTextInputValue(id: string) {
      return interaction.fields.getTextInputValue(id)
    },
    getFiles(id: string) {
      const field = interaction.fields.fields.get(id)
      if (!field || field.type !== 19) {
        return []
      }
      const attachments = field.attachments
      if (!attachments) {
        return []
      }
      return [...attachments.values()].map((attachment) => {
        return wrapUploadedFile({ attachment })
      })
    },
  }
}

function wrapUploadedFile({ attachment }: { attachment: Attachment }): PlatformUploadedFile {
  return {
    id: attachment.id,
    url: attachment.url,
    name: attachment.name,
    contentType: attachment.contentType,
  }
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
  readonly admin: PlatformAdmin = {
    listGuilds: async () => {
      const cacheValues = [...this.client.guilds.cache.values()]
      const guilds = cacheValues.length > 0
        ? cacheValues
        : [...(await this.client.guilds.fetch()).values()]

      const hydratedGuilds = await Promise.all(
        guilds.map(async (guildRef) => {
          const guild = await this.client.guilds.fetch(guildRef.id)
          discordGuildStore.set(guild.id, guild)
          const summary: PlatformGuildSummary = {
            id: guild.id,
            name: guild.name,
            memberCount: guild.memberCount,
            ownerId: guild.ownerId,
          }
          return summary
        }),
      )
      return hydratedGuilds
    },
    resolveGuild: async ({ guildId, fromChannelId, fallbackFirst }) => {
      if (guildId) {
        const guild = await this.client.guilds.fetch(guildId).catch(() => {
          return null
        })
        if (guild) {
          discordGuildStore.set(guild.id, guild)
          return {
            id: guild.id,
            name: guild.name,
            memberCount: guild.memberCount,
            ownerId: guild.ownerId,
          }
        }
      }

      if (fromChannelId) {
        const channel = await this.client.channels.fetch(fromChannelId).catch(() => {
          return null
        })
        if (channel && 'guild' in channel && channel.guild) {
          const guild = channel.guild
          discordGuildStore.set(guild.id, guild)
          return {
            id: guild.id,
            name: guild.name,
            memberCount: guild.memberCount,
            ownerId: guild.ownerId,
          }
        }
      }

      if (!fallbackFirst) {
        return null
      }
      const firstGuild = await this.admin.listGuilds().then((guilds) => {
        return guilds[0] || null
      })
      return firstGuild
    },
    registerCommands: async ({
      appId,
      guildIds,
      commands,
      commandNamesForLegacyCleanup,
      allowLegacyGlobalCleanup,
    }) => {
      const results = await Promise.allSettled(
        guildIds.map(async (guildId) => {
          const route = Routes.applicationGuildCommands(appId, guildId)
          const result = await this.client.rest.put(route, {
            body: commands,
          })
          const registeredCount = Array.isArray(result) ? result.length : 0
          return {
            guildId,
            registeredCount,
          }
        }),
      )

      const failedGuilds = results.flatMap((result) => {
        if (result.status === 'fulfilled') {
          return []
        }
        return [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
      })
      if (failedGuilds.length > 0) {
        throw new Error(
          `Failed to register slash commands for ${failedGuilds.length} guild(s)`,
        )
      }

      if (allowLegacyGlobalCleanup) {
        const globalRoute = Routes.applicationCommands(appId)
        const response = await this.client.rest.get(globalRoute)
        if (Array.isArray(response)) {
          const commandNames = new Set(commandNamesForLegacyCleanup)
          const legacyCommands = response.filter((command): command is { id: string; name: string } => {
            if (!command || typeof command !== 'object') {
              return false
            }
            const commandName = 'name' in command ? command.name : undefined
            const commandId = 'id' in command ? command.id : undefined
            if (typeof commandName !== 'string' || typeof commandId !== 'string') {
              return false
            }
            return commandNames.has(commandName)
          })
          await Promise.allSettled(
            legacyCommands.map(async (command) => {
              await this.client.rest.delete(
                Routes.applicationCommand(appId, command.id),
              )
            }),
          )
        }
      }

      const firstFulfilled = results.find((result) => {
        return result.status === 'fulfilled'
      })
      return {
        registeredGuildCount: results.length,
        registeredCommandCount:
          firstFulfilled && firstFulfilled.status === 'fulfilled'
            ? firstFulfilled.value.registeredCount
            : commands.length,
      }
    },
    ensureGuildAccessPolicy: async ({ guildId }) => {
      const guild = await this.client.guilds.fetch(guildId)
      discordGuildStore.set(guild.id, guild)
      const roles = await guild.roles.fetch()
      const existingRole = roles.find((role) => {
        return role.name.toLowerCase() === 'kimaki'
      })
      if (existingRole) {
        if (existingRole.position > 1) {
          await existingRole.setPosition(1)
        }
        return
      }
      await guild.roles.create({
        name: 'Kimaki',
        position: 1,
        reason:
          'Kimaki bot permission role - assign to users who can start sessions, send messages in threads, and use voice features',
      })
    },
    listChannels: async ({ guildId }) => {
      const guild = await this.client.guilds.fetch(guildId)
      discordGuildStore.set(guild.id, guild)
      await guild.channels.fetch()
      return [...guild.channels.cache.values()].map((channel) => {
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
        return wrapOtherChannel({
          id: channel.id,
          guildId,
          name: 'name' in channel ? channel.name : undefined,
          parentId: 'parentId' in channel ? channel.parentId : null,
        })
      })
    },
    createCategory: async ({ guildId, name }) => {
      const guild = await this.client.guilds.fetch(guildId)
      discordGuildStore.set(guild.id, guild)
      const created = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
      })
      return wrapOtherChannel({ id: created.id, guildId, name: created.name })
    },
    createTextChannel: async ({ guildId, name, parentId, topic }) => {
      const guild = await this.client.guilds.fetch(guildId)
      discordGuildStore.set(guild.id, guild)
      const created = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: parentId,
        topic,
      })
      if (created.type !== ChannelType.GuildText) {
        throw new Error(`Created non-text channel for ${name}`)
      }
      return wrapChannel(created)
    },
    createVoiceChannel: async ({ guildId, name, parentId }) => {
      const guild = await this.client.guilds.fetch(guildId)
      discordGuildStore.set(guild.id, guild)
      const created = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: parentId,
      })
      return wrapOtherChannel({
        id: created.id,
        guildId,
        name: created.name,
        parentId: created.parentId,
      })
    },
    fetchChannel: async ({ guildId, channelId }) => {
      const guild = await this.client.guilds.fetch(guildId)
      discordGuildStore.set(guild.id, guild)
      const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId))
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
      return wrapOtherChannel({
        id: channel.id,
        guildId,
        name: 'name' in channel ? channel.name : undefined,
        parentId: 'parentId' in channel ? channel.parentId : null,
      })
    },
    fetchChannelById: async ({ channelId }) => {
      const channel = await this.client.channels.fetch(channelId)
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
      return wrapOtherChannel({
        id: channel.id,
        guildId: 'guildId' in channel ? channel.guildId || null : null,
        name: 'name' in channel ? channel.name : undefined,
        parentId: 'parentId' in channel ? channel.parentId : null,
      })
    },
    deleteChannel: async ({ guildId, channelId, reason }) => {
      const guild = await this.client.guilds.fetch(guildId)
      discordGuildStore.set(guild.id, guild)
      const channel = await guild.channels.fetch(channelId)
      if (!channel) {
        return 'missing'
      }
      await channel.delete(reason)
      return 'deleted'
    },
    listGuildMembers: async ({ guildId, limit }) => {
      const guild = await this.client.guilds.fetch(guildId)
      discordGuildStore.set(guild.id, guild)
      const members = await guild.members.list({ limit: limit || 20 })
      return [...members.values()].map((member) => {
        return wrapGuildMemberSummary(member)
      })
    },
    searchGuildMembers: async ({ guildId, query, limit }) => {
      const guild = await this.client.guilds.fetch(guildId)
      discordGuildStore.set(guild.id, guild)
      const members = await guild.members.search({ query, limit: limit || 10 })
      return [...members.values()].map((member) => {
        return wrapGuildMemberSummary(member)
      })
    },
    fetchCommandDescription: async ({ guildId, commandId }) => {
      const guild = await this.client.guilds.fetch(guildId)
      discordGuildStore.set(guild.id, guild)
      const command = await guild.commands.fetch(commandId)
      return command?.description
    },
  }
  readonly client: Client
  readonly content = {
    resolveMentions: async (message: PlatformMessage) => {
      const discordMessage = this.getStoredMessage(message)
      return resolveMentions(discordMessage)
    },
    getTextAttachments: async (message: PlatformMessage) => {
      const discordMessage = this.getStoredMessage(message)
      return getTextAttachments(discordMessage)
    },
    getFileAttachments: async (message: PlatformMessage) => {
      const discordMessage = this.getStoredMessage(message)
      return getFileAttachments(discordMessage)
    },
  }
  readonly permissions = {
    getMessageAccess: async (message: PlatformMessage): Promise<MessageAccess> => {
      const discordMessage = this.getStoredMessage(message)
      if (hasNoKimakiRole(discordMessage.member)) {
        return 'blocked'
      }
      if (!hasKimakiBotPermission(discordMessage.member)) {
        return 'denied'
      }
      return 'allowed'
    },
  }
  readonly voice = {
    processAttachment: async (input: {
      message: PlatformMessage
      thread: PlatformThread
      projectDirectory?: string
      isNewThread?: boolean
      appId?: string
      currentSessionContext?: string
      lastSessionContext?: string
    }) => {
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
    },
  }

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

  private getStoredMessage(message: PlatformMessage): Message {
    const stored = discordMessageStore.get(
      getDiscordMessageStoreKey({ channelId: message.channelId, messageId: message.id }),
    )
    if (!stored) {
      throw new Error(`Discord message is not available in adapter cache: ${message.id}`)
    }
    return stored
  }

  private async getThreadChannel({
    threadId,
    parentId,
  }: {
    threadId: string
    parentId?: string | null
  }): Promise<ThreadChannel> {
    const channel = await this.getTargetChannel({
      channelId: parentId || threadId,
      threadId,
    })
    if (!(channel instanceof ThreadChannel)) {
      throw new Error(`Channel ${threadId} is not a thread target`)
    }
    return channel
  }

  private createConversation(target: MessageTarget): PlatformConversation {
    return {
      target,
      send: async (message) => {
        const channel = await this.getTargetChannel(target)
        if (message.files && message.files.length > 0) {
          const sent = await channel.send({
            content: message.markdown.slice(0, 2000),
            flags: message.flags,
            embeds: message.embeds,
            files: message.files.map((file) => {
              return {
                attachment: Buffer.from(file.data),
                name: file.filename,
                contentType: file.contentType,
              }
            }),
            reply: message.replyToMessageId
              ? { messageReference: message.replyToMessageId }
              : undefined,
          })
          return { id: sent.id }
        }
        if (message.buttons || message.selectMenu || message.selectMenus) {
          const sent = await channel.send({
            content: message.markdown.slice(0, 2000),
            flags: message.flags,
            embeds: message.embeds,
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
      },
      update: async (messageId, message) => {
        const targetMessage = await this.getMessageTarget(target, messageId)
        await targetMessage.edit({
          content: message.markdown,
          flags: message.flags,
          embeds: message.embeds,
          components: message.buttons || message.selectMenu || message.selectMenus
            ? buildMessageComponents({
                buttons: message.buttons,
                selectMenu: message.selectMenu,
                selectMenus: message.selectMenus,
              })
            : [],
        })
      },
      delete: async (messageId) => {
        const targetMessage = await this.getMessageTarget(target, messageId)
        await targetMessage.delete()
      },
      message: async (messageId): Promise<PlatformConversationMessage> => {
        const message = await this.getMessageTarget(target, messageId)
        return {
          data: wrapMessage(message),
          startThread: async ({ name, autoArchiveDuration, reason }) => {
            const thread = await message.startThread({
              name,
              autoArchiveDuration,
              reason,
            })
            return {
              thread: wrapThread(thread),
              target: {
                channelId: thread.parentId || thread.id,
                threadId: thread.id,
              },
            }
          },
        }
      },
      startTyping: async () => {
        const channel = await this.getTargetChannel(target)
        await channel.sendTyping()
      },
    }
  }

  conversation(target: MessageTarget): PlatformConversation {
    return this.createConversation(target)
  }

  async channel(channelId: string): Promise<PlatformChannelHandle | null> {
    const cached = this.client.channels.cache.get(channelId)
    const channel = cached || (await this.client.channels.fetch(channelId))
    if (!channel) {
      return null
    }
    if (channel.type === ChannelType.GuildText) {
      const data = wrapChannel(channel)
      return {
        data,
        conversation: () => {
          return this.createConversation({ channelId: data.id })
        },
      }
    }
    if (
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread
    ) {
      const data = wrapChannel(channel)
      return {
        data,
        conversation: () => {
          return this.createConversation({
            channelId: data.parentId || data.id,
            threadId: data.id,
          })
        },
      }
    }
    return {
      data: {
        id: channel.id,
        kind: 'other',
        type: 'other',
        parentId: null,
        guildId: 'guildId' in channel ? channel.guildId || null : null,
        isThread() {
          return false
        },
      },
      conversation: () => {
        return this.createConversation({ channelId: channel.id })
      },
    }
  }

  async thread({
    threadId,
    parentId,
  }: {
    threadId: string
    parentId?: string | null
  }): Promise<PlatformThreadHandle | null> {
    const thread = await this.getThreadChannel({ threadId, parentId }).catch(() => {
      return null
    })
    if (!thread) {
      return null
    }
    const data = wrapThread(thread)
    return {
      data,
      conversation: () => {
        return this.createConversation({
          channelId: data.parentId || data.id,
          threadId: data.id,
        })
      },
      message: async (messageId) => {
        return this.createConversation({
          channelId: data.parentId || data.id,
          threadId: data.id,
        }).message(messageId)
      },
      starterMessage: async () => {
        const starter = await thread.fetchStarterMessage().catch(() => {
          return null
        })
        if (!starter) {
          return null
        }
        return wrapMessage(starter)
      },
      rename: async (name) => {
        await thread.setName(name)
      },
      archive: async () => {
        await thread.setArchived(true)
      },
      addMember: async (userId) => {
        await thread.members.add(userId)
      },
      addStarterReaction: async (emoji) => {
        await this.client.rest.put(
          Routes.channelMessageOwnReaction(
            data.parentId || data.id,
            data.id,
            encodeURIComponent(emoji),
          ),
        )
      },
      reference: () => {
        return `<#${data.id}>`
      },
    }
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
          embeds: firstMessage ? undefined : message.embeds,
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
          embeds: firstMessage ? undefined : message.embeds,
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
        embeds: message.embeds,
        reply: message.replyToMessageId
          ? { messageReference: message.replyToMessageId }
          : undefined,
      })
      firstMessage = sent
    }

    return { id: firstMessage.id }
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
      const conversation = this.createConversation(target)
      void handler({
        message: wrapMessage(normalizedMessage),
        thread: isThread
          ? wrapThread(normalizedMessage.channel as ThreadChannel)
          : undefined,
        conversation,
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
      const threadHandle: PlatformThreadHandle = {
        data: wrapThread(thread),
        conversation: () => {
          return this.createConversation({
            channelId: thread.parentId || thread.id,
            threadId: thread.id,
          })
        },
        message: async (messageId) => {
          return this.createConversation({
            channelId: thread.parentId || thread.id,
            threadId: thread.id,
          }).message(messageId)
        },
        starterMessage: async () => {
          const starter = await thread.fetchStarterMessage().catch(() => {
            return null
          })
          if (!starter) {
            return null
          }
          return wrapMessage(starter)
        },
        rename: async (name) => {
          await thread.setName(name)
        },
        archive: async () => {
          await thread.setArchived(true)
        },
        addMember: async (userId) => {
          await thread.members.add(userId)
        },
        addStarterReaction: async (emoji) => {
          await this.client.rest.put(
            Routes.channelMessageOwnReaction(
              thread.parentId || thread.id,
              thread.id,
              encodeURIComponent(emoji),
            ),
          )
        },
        reference: () => {
          return `<#${thread.id}>`
        },
      }
      void handler({
        thread: threadHandle.data,
        threadHandle,
        conversation: threadHandle.conversation(),
        newlyCreated,
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
      appId,
      commandName: interaction.commandName,
      commandId: interaction.commandId,
      commandDescription: interaction.command?.description,
      channel: wrapOptionalChannel(interaction.channel),
      channelId: interaction.channelId,
      guild: wrapServer({ guild: interaction.guild }),
      guildId: interaction.guildId,
      user: wrapUser({
        user: interaction.user,
        displayName: getInteractionDisplayName({ member: interaction.member, user: interaction.user }),
      }),
      access: getInteractionAccess({ member: interaction.member, guild: interaction.guild }),
      options: createCommandOptions({ interaction }),
      deferred: interaction.deferred,
      replied: interaction.replied,
      botUserName: interaction.client.user?.username,
      reply: async (options) => {
        await interaction.reply(normalizeReplyOptions(options))
      },
      replyUi: async (message) => {
        await interaction.reply(buildInteractionUiMessage(message))
      },
      deferReply: async (options?: PlatformDeferReplyOptions) => {
        await interaction.deferReply(normalizeDeferReplyOptions(options))
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
      appId,
      commandName: interaction.commandName,
      channel: wrapOptionalChannel(interaction.channel),
      channelId: interaction.channelId,
      guild: wrapServer({ guild: interaction.guild }),
      guildId: interaction.guildId,
      user: wrapUser({
        user: interaction.user,
        displayName: getInteractionDisplayName({ member: interaction.member, user: interaction.user }),
      }),
      botUserName: interaction.client.user?.username,
      options: createCommandOptions({ interaction }),
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
    const event: ButtonEvent = {
      appId,
      customId: interaction.customId,
      channel: wrapOptionalChannel(interaction.channel),
      channelId: interaction.channelId,
      guild: wrapServer({ guild: interaction.guild }),
      guildId: interaction.guildId,
      user: wrapUser({
        user: interaction.user,
        displayName: getInteractionDisplayName({ member: interaction.member, user: interaction.user }),
      }),
      access: getInteractionAccess({ member: interaction.member, guild: interaction.guild }),
      message: wrapMessage(interaction.message),
      deferred: interaction.deferred,
      replied: interaction.replied,
      botUserName: interaction.client.user?.username,
      reply: async (options) => {
        await interaction.reply(normalizeReplyOptions(options))
      },
      replyUi: async (message) => {
        await interaction.reply(buildInteractionUiMessage(message))
      },
      deferReply: async (options?: PlatformDeferReplyOptions) => {
        await interaction.deferReply(normalizeDeferReplyOptions(options))
      },
      editReply: async (options) => {
        await interaction.editReply(normalizeEditReplyOptions(options))
      },
      editUiReply: async (message) => {
        await interaction.editReply(buildInteractionUiMessage(message))
      },
      followUp: async (options) => {
        await interaction.followUp(normalizeReplyOptions(options))
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
      // Self-referential: passes the wrapped event to handleHtmlActionButton
      runHtmlAction: async () => {
        if (!interaction.customId.startsWith('html_action:')) {
          return false
        }
        await handleHtmlActionButton(event)
        return true
      },
    }
    return event
  }

  private wrapSelectMenuEvent({
    interaction,
    appId,
  }: {
    interaction: StringSelectMenuInteraction
    appId: string
  }): SelectMenuEvent {
    return {
      appId,
      customId: interaction.customId,
      channel: wrapOptionalChannel(interaction.channel),
      channelId: interaction.channelId,
      guild: wrapServer({ guild: interaction.guild }),
      guildId: interaction.guildId,
      user: wrapUser({
        user: interaction.user,
        displayName: getInteractionDisplayName({ member: interaction.member, user: interaction.user }),
      }),
      access: getInteractionAccess({ member: interaction.member, guild: interaction.guild }),
      message: wrapMessage(interaction.message),
      values: [...interaction.values],
      deferred: interaction.deferred,
      replied: interaction.replied,
      botUserName: interaction.client.user?.username,
      reply: async (options) => {
        await interaction.reply(normalizeReplyOptions(options))
      },
      replyUi: async (message) => {
        await interaction.reply(buildInteractionUiMessage(message))
      },
      deferReply: async (options?: PlatformDeferReplyOptions) => {
        await interaction.deferReply(normalizeDeferReplyOptions(options))
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
      appId,
      customId: interaction.customId,
      channel: wrapOptionalChannel(interaction.channel),
      channelId: interaction.channelId,
      guild: wrapServer({ guild: interaction.guild }),
      guildId: interaction.guildId,
      user: wrapUser({
        user: interaction.user,
        displayName: getInteractionDisplayName({ member: interaction.member, user: interaction.user }),
      }),
      access: getInteractionAccess({ member: interaction.member, guild: interaction.guild }),
      fields: createModalFields({ interaction }),
      deferred: interaction.deferred,
      replied: interaction.replied,
      botUserName: interaction.client.user?.username,
      reply: async (options) => {
        await interaction.reply(normalizeReplyOptions(options))
      },
      replyUi: async (message) => {
        await interaction.reply(buildInteractionUiMessage(message))
      },
      deferReply: async (options?: PlatformDeferReplyOptions) => {
        await interaction.deferReply(normalizeDeferReplyOptions(options))
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
