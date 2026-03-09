// Platform adapter types for Kimaki's chat transport boundary.
// Keeps core runtime code on a small message/thread API while adapters own
// native gateway, webhook, and message rendering details.

import type {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  CacheType,
  InteractionReplyOptions,
  InteractionEditReplyOptions,
  InteractionUpdateOptions,
  InteractionDeferReplyOptions,
} from 'discord.js'
import type { DiscordFileAttachment } from '../message-formatting.js'
import type { TranscriptionResult } from '../voice.js'

export type MessageTarget = {
  channelId: string
  threadId?: string
}

export type OutgoingMessage = {
  markdown: string
  flags?: number
  replyToMessageId?: string
  buttons?: UiButton[]
  selectMenu?: UiSelectMenu
  selectMenus?: UiSelectMenu[]
}

// Platform-agnostic button style.
// Discord adapter maps these to discord.js ButtonStyle enum values.
// Slack adapter maps 'success'/'danger' to Block Kit 'primary'/'danger' styles.
export type UiButtonStyle = 'primary' | 'secondary' | 'success' | 'danger' | 'link'

export type UiButton = {
  id: string
  label: string
  style?: UiButtonStyle
}

export type UiSelectOption = {
  label: string
  value: string
  description?: string
}

export type UiSelectMenu = {
  id: string
  placeholder?: string
  options: UiSelectOption[]
  minValues?: number
  maxValues?: number
}

export type UiModalInput =
  | {
      type: 'text'
      id: string
      label: string
      placeholder?: string
      required?: boolean
      style?: 'short' | 'paragraph'
    }
  | {
      type: 'file'
      id: string
      label: string
      description?: string
      minFiles?: number
      maxFiles?: number
    }

export type UiModal = {
  id: string
  title: string
  inputs: UiModalInput[]
}

export type PlatformChannel = {
  id: string
  name?: string
  kind: 'text' | 'thread' | 'other'
  topic?: string | null
  raw: unknown
}

export type MessageAccess = 'allowed' | 'blocked' | 'denied'

export type PlatformMessage = {
  id: string
  content: string | null
  channelId: string
  author: {
    id: string
    username: string
    displayName?: string
    bot: boolean
  }
  attachments: ReadonlyMap<
    string,
    {
      url: string
      contentType?: string | null
      name?: string
    }
  >
  embeds: Array<{
    data?: {
      footer?: {
        text?: string
      }
    }
  }>
  raw: unknown
}

export type PlatformThread = {
  id: string
  name: string
  parentId: string | null
  guildId?: string | null
  createdTimestamp?: number | null
  raw: unknown
}

export type IncomingMessageEvent = {
  message: PlatformMessage
  thread?: PlatformThread
  target: MessageTarget
  kind: 'channel' | 'thread'
  isMention: boolean
  isSelf?: boolean
}

export type IncomingThreadEvent = {
  thread: PlatformThread
  target: MessageTarget & { threadId: string }
  newlyCreated: boolean
}

export type LegacyReplyOptions = string | InteractionReplyOptions
export type LegacyEditReplyOptions = string | InteractionEditReplyOptions
export type LegacyUpdateOptions = string | InteractionUpdateOptions

export type CommandEvent = {
  raw: ChatInputCommandInteraction<CacheType>
  appId: string
  commandName: string
  commandId: string
  client: ChatInputCommandInteraction<CacheType>['client']
  channel: ChatInputCommandInteraction<CacheType>['channel']
  channelId: string
  guild: ChatInputCommandInteraction<CacheType>['guild']
  guildId: string | null
  member: ChatInputCommandInteraction<CacheType>['member']
  user: ChatInputCommandInteraction<CacheType>['user']
  options: ChatInputCommandInteraction<CacheType>['options']
  command: ChatInputCommandInteraction<CacheType>['command']
  deferred: boolean
  replied: boolean
  reply(options: LegacyReplyOptions): Promise<void>
  replyUi(message: OutgoingMessage): Promise<void>
  deferReply(options?: InteractionDeferReplyOptions): Promise<void>
  editReply(options: LegacyEditReplyOptions): Promise<void>
  editUiReply(message: OutgoingMessage): Promise<void>
  showModal(modal: UiModal): Promise<void>
}

export type AutocompleteEvent = {
  raw: AutocompleteInteraction<CacheType>
  appId: string
  commandName: string
  channel: AutocompleteInteraction<CacheType>['channel']
  channelId: string | null
  guild: AutocompleteInteraction<CacheType>['guild']
  guildId: string | null
  member: AutocompleteInteraction<CacheType>['member']
  user: AutocompleteInteraction<CacheType>['user']
  options: AutocompleteInteraction<CacheType>['options']
  respond(
    options: Array<{ name: string; value: string | number }>,
  ): Promise<void>
}

export type ButtonEvent = {
  raw: ButtonInteraction<CacheType>
  appId: string
  customId: string
  client: ButtonInteraction<CacheType>['client']
  channel: ButtonInteraction<CacheType>['channel']
  channelId: string
  guild: ButtonInteraction<CacheType>['guild']
  guildId: string | null
  member: ButtonInteraction<CacheType>['member']
  user: ButtonInteraction<CacheType>['user']
  message: ButtonInteraction<CacheType>['message']
  deferred: boolean
  replied: boolean
  reply(options: LegacyReplyOptions): Promise<void>
  replyUi(message: OutgoingMessage): Promise<void>
  deferReply(options?: InteractionDeferReplyOptions): Promise<void>
  editReply(options: LegacyEditReplyOptions): Promise<void>
  editUiReply(message: OutgoingMessage): Promise<void>
  followUp(options: string | InteractionReplyOptions): Promise<void>
  deferUpdate(options?: { withResponse?: boolean }): Promise<void>
  update(options: LegacyUpdateOptions): Promise<void>
  updateUi(message: OutgoingMessage): Promise<void>
  showModal(modal: UiModal): Promise<void>
}

export type SelectMenuEvent = {
  raw: StringSelectMenuInteraction<CacheType>
  appId: string
  customId: string
  client: StringSelectMenuInteraction<CacheType>['client']
  channel: StringSelectMenuInteraction<CacheType>['channel']
  channelId: string
  guild: StringSelectMenuInteraction<CacheType>['guild']
  guildId: string | null
  member: StringSelectMenuInteraction<CacheType>['member']
  user: StringSelectMenuInteraction<CacheType>['user']
  message: StringSelectMenuInteraction<CacheType>['message']
  values: string[]
  deferred: boolean
  replied: boolean
  reply(options: LegacyReplyOptions): Promise<void>
  replyUi(message: OutgoingMessage): Promise<void>
  deferReply(options?: InteractionDeferReplyOptions): Promise<void>
  editReply(options: LegacyEditReplyOptions): Promise<void>
  editUiReply(message: OutgoingMessage): Promise<void>
  deferUpdate(options?: { withResponse?: boolean }): Promise<void>
  update(options: LegacyUpdateOptions): Promise<void>
  updateUi(message: OutgoingMessage): Promise<void>
  showModal(modal: UiModal): Promise<void>
}

export type ModalSubmitEvent = {
  raw: ModalSubmitInteraction<CacheType>
  appId: string
  customId: string
  client: ModalSubmitInteraction<CacheType>['client']
  channel: ModalSubmitInteraction<CacheType>['channel']
  channelId: string | null
  guild: ModalSubmitInteraction<CacheType>['guild']
  guildId: string | null
  member: ModalSubmitInteraction<CacheType>['member']
  user: ModalSubmitInteraction<CacheType>['user']
  fields: ModalSubmitInteraction<CacheType>['fields']
  deferred: boolean
  replied: boolean
  reply(options: LegacyReplyOptions): Promise<void>
  replyUi(message: OutgoingMessage): Promise<void>
  deferReply(options?: InteractionDeferReplyOptions): Promise<void>
  editReply(options: LegacyEditReplyOptions): Promise<void>
  editUiReply(message: OutgoingMessage): Promise<void>
}

export interface KimakiAdapter {
  readonly name: string

  login(token: string): Promise<void>
  destroy(): void

  sendMessage(
    target: MessageTarget,
    message: OutgoingMessage,
  ): Promise<{ id: string }>

  updateMessage(
    target: MessageTarget,
    messageId: string,
    message: OutgoingMessage,
  ): Promise<void>

  deleteMessage(target: MessageTarget, messageId: string): Promise<void>

  fetchMessage(target: MessageTarget, messageId: string): Promise<PlatformMessage>

  fetchChannel?(channelId: string): Promise<PlatformChannel | null>

  startTyping(target: MessageTarget): Promise<void>

  renameThread(threadId: string, name: string): Promise<void>

  formatThreadReference?(thread: PlatformThread): string

  resolveMentions?(message: PlatformMessage): Promise<string>

  getTextAttachments?(message: PlatformMessage): Promise<string>

  getFileAttachments?(message: PlatformMessage): Promise<DiscordFileAttachment[]>

  getMessageAccess?(message: PlatformMessage): Promise<MessageAccess>

  processVoiceAttachment?(input: {
    message: PlatformMessage
    thread: PlatformThread
    projectDirectory?: string
    isNewThread?: boolean
    appId?: string
    currentSessionContext?: string
    lastSessionContext?: string
  }): Promise<TranscriptionResult | null>

  createThreadFromMessage(input: {
    message: PlatformMessage
    name: string
    autoArchiveDuration: number
    reason: string
  }): Promise<{
    thread: PlatformThread
    target: MessageTarget & { threadId: string }
  }>

  createThread(input: {
    channelId: string
    messageId: string
    name: string
    autoArchiveDuration: number
    reason: string
  }): Promise<{
    thread: PlatformThread
    target: MessageTarget & { threadId: string }
  }>

  addThreadMember(threadId: string, userId: string): Promise<void>

  addThreadStarterReaction(
    input: { channelId: string; threadId: string },
    emoji: string,
  ): Promise<void>

  fetchStarterMessage(threadId: string): Promise<PlatformMessage | null>

  onReady(handler: () => void): void
  onMessage(handler: (event: IncomingMessageEvent) => void | Promise<void>): void
  onThreadCreate(
    handler: (event: IncomingThreadEvent) => void | Promise<void>,
  ): void
  onThreadDelete(handler: (threadId: string) => void): void
  onCommand(handler: (event: CommandEvent) => void | Promise<void>): void
  onAutocomplete(
    handler: (event: AutocompleteEvent) => void | Promise<void>,
  ): void
  onButton(handler: (event: ButtonEvent) => void | Promise<void>): void
  onSelectMenu(handler: (event: SelectMenuEvent) => void | Promise<void>): void
  onModalSubmit(
    handler: (event: ModalSubmitEvent) => void | Promise<void>,
  ): void
  onError(handler: (error: Error) => void): void
}
