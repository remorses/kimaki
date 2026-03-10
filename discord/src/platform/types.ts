// Platform adapter types for Kimaki's transport boundary.
// Shared runtime code only sees normalized resources, interactions, and
// explicit capabilities. Adapters keep platform SDK values private.

import type { FilePartInput } from '@opencode-ai/sdk/v2'
import type { PlatformMessageTopLevelComponent } from './components-v2.js'
import type { TranscriptionResult } from '../voice.js'

export type MessageTarget = {
  channelId: string
  threadId?: string
}

export type PlatformEmbed = {
  color?: number
  footer?: {
    text?: string
  }
}

export type OutgoingFileAttachment = {
  filename: string
  contentType: string
  data: Uint8Array
}


export type OutgoingMessage = {
  markdown: string
  flags?: number
  replyToMessageId?: string
  embeds?: PlatformEmbed[]
  files?: OutgoingFileAttachment[]
  buttons?: UiButton[]
  selectMenu?: UiSelectMenu
  selectMenus?: UiSelectMenu[]
}

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
  default?: boolean
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

export type PlatformChannelKind = 'text' | 'thread' | 'other'

export type PlatformUser = {
  id: string
  username: string
  displayName: string
  globalName?: string
  bot: boolean
}

export type PlatformChannel = {
  id: string
  name?: string
  kind: PlatformChannelKind
  type: PlatformChannelKind
  parentId: string | null
  guildId?: string | null
  topic?: string | null
  createdTimestamp?: number | null
  isThread(): boolean
}

export type PlatformThread = PlatformChannel & {
  kind: 'thread'
  name: string
}

export type PlatformFileAttachment = FilePartInput & {
  sourceUrl?: string
}

export type MessageAccess = 'allowed' | 'blocked' | 'denied'

export type PlatformMessage = {
  id: string
  content: string | null
  channelId: string
  author: PlatformUser
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
}

export interface PlatformConversationMessage {
  readonly data: PlatformMessage
  startThread(input: {
    name: string
    autoArchiveDuration: number
    reason: string
  }): Promise<{
    thread: PlatformThread
    target: MessageTarget & { threadId: string }
  }>
}

export interface PlatformConversation {
  readonly target: MessageTarget
  send(message: OutgoingMessage): Promise<{ id: string }>
  update(messageId: string, message: OutgoingMessage): Promise<void>
  delete(messageId: string): Promise<void>
  message(messageId: string): Promise<PlatformConversationMessage>
  startTyping(): Promise<void>
}

export interface PlatformChannelHandle {
  readonly data: PlatformChannel
  conversation(): PlatformConversation
}

export interface PlatformThreadHandle {
  readonly data: PlatformThread
  conversation(): PlatformConversation
  message(messageId: string): Promise<PlatformConversationMessage>
  starterMessage(): Promise<PlatformMessage | null>
  rename(name: string): Promise<void>
  archive(): Promise<void>
  addMember(userId: string): Promise<void>
  addStarterReaction(emoji: string): Promise<void>
  reference(): string
}

export type PlatformGuildMemberSummary = {
  id: string
  username: string
  globalName?: string
  nick?: string
}

export type IncomingMessageEvent = {
  message: PlatformMessage
  thread?: PlatformThread
  conversation: PlatformConversation
  kind: 'channel' | 'thread'
  isMention: boolean
  isSelf?: boolean
}

export type IncomingThreadEvent = {
  thread: PlatformThread
  threadHandle: PlatformThreadHandle
  conversation: PlatformConversation
  newlyCreated: boolean
}

export type PlatformInteractionMessage = {
  content?: string
  flags?: number
  components?: PlatformMessageTopLevelComponent[]
}

export type LegacyReplyOptions = string | PlatformInteractionMessage
export type LegacyEditReplyOptions = string | PlatformInteractionMessage
export type LegacyUpdateOptions = string | PlatformInteractionMessage

export type PlatformDeferReplyOptions = {
  flags?: number
  ephemeral?: boolean
}

export type PlatformInteractionAccess = {
  canUseKimaki: boolean
  isBlocked: boolean
}

export type PlatformServer = {
  id: string
  name?: string
}

export type PlatformGuildSummary = PlatformServer & {
  memberCount?: number
  ownerId?: string
}

export type PlatformAdmin = {
  listGuilds(): Promise<PlatformGuildSummary[]>
  resolveGuild(input: {
    guildId?: string
    fromChannelId?: string
    fallbackFirst?: boolean
  }): Promise<PlatformGuildSummary | null>
  registerCommands(input: {
    appId: string
    guildIds: string[]
    commands: Array<Record<string, unknown>>
    commandNamesForLegacyCleanup: string[]
    allowLegacyGlobalCleanup: boolean
  }): Promise<{
    registeredGuildCount: number
    registeredCommandCount: number
  }>
  ensureGuildAccessPolicy(input: {
    guildId: string
  }): Promise<void>
  listChannels(input: { guildId: string }): Promise<PlatformChannel[]>
  createCategory(input: {
    guildId: string
    name: string
  }): Promise<PlatformChannel>
  createTextChannel(input: {
    guildId: string
    name: string
    parentId?: string
    topic?: string
  }): Promise<PlatformChannel>
  createVoiceChannel?(input: {
    guildId: string
    name: string
    parentId?: string
  }): Promise<PlatformChannel>
  fetchChannel(input: {
    guildId: string
    channelId: string
  }): Promise<PlatformChannel | null>
  fetchChannelById(input: { channelId: string }): Promise<PlatformChannel | null>
  deleteChannel(input: {
    guildId: string
    channelId: string
    reason?: string
  }): Promise<'deleted' | 'missing'>
  listGuildMembers(input: {
    guildId: string
    limit?: number
  }): Promise<PlatformGuildMemberSummary[]>
  searchGuildMembers(input: {
    guildId: string
    query: string
    limit?: number
  }): Promise<PlatformGuildMemberSummary[]>
  fetchCommandDescription?(input: {
    guildId: string
    commandId: string
  }): Promise<string | undefined>
}

export interface PlatformCommandOptions {
  getString(name: string, required?: boolean): string
  getFocused(withMeta?: true): string | { name: string; value: string }
}

export type PlatformUploadedFile = {
  id: string
  url: string
  name: string
  contentType?: string | null
}

export interface PlatformModalFields {
  getTextInputValue(id: string): string
  getFiles(id: string): PlatformUploadedFile[]
}

export type BaseInteractionEvent = {
  appId: string
  channel: PlatformChannel | null
  channelId: string | null
  guild: PlatformServer | null
  guildId: string | null
  user: PlatformUser
  access: PlatformInteractionAccess
  deferred: boolean
  replied: boolean
  botUserName?: string
}

export type CommandEvent = BaseInteractionEvent & {
  commandName: string
  commandId: string
  commandDescription?: string
  options: PlatformCommandOptions
  reply(options: LegacyReplyOptions): Promise<void>
  replyUi(message: OutgoingMessage): Promise<void>
  deferReply(options?: PlatformDeferReplyOptions): Promise<void>
  editReply(options: LegacyEditReplyOptions): Promise<void>
  editUiReply(message: OutgoingMessage): Promise<void>
  showModal(modal: UiModal): Promise<void>
}

export type AutocompleteEvent = Pick<
  BaseInteractionEvent,
  'appId' | 'channel' | 'channelId' | 'guild' | 'guildId' | 'user' | 'botUserName'
> & {
  commandName: string
  options: PlatformCommandOptions
  respond(
    options: Array<{ name: string; value: string | number }>,
  ): Promise<void>
}

export type ButtonEvent = BaseInteractionEvent & {
  customId: string
  message: PlatformMessage
  reply(options: LegacyReplyOptions): Promise<void>
  replyUi(message: OutgoingMessage): Promise<void>
  deferReply(options?: PlatformDeferReplyOptions): Promise<void>
  editReply(options: LegacyEditReplyOptions): Promise<void>
  editUiReply(message: OutgoingMessage): Promise<void>
  followUp(options: LegacyReplyOptions): Promise<void>
  deferUpdate(options?: { withResponse?: boolean }): Promise<void>
  update(options: LegacyUpdateOptions): Promise<void>
  updateUi(message: OutgoingMessage): Promise<void>
  showModal(modal: UiModal): Promise<void>
  runHtmlAction?(): Promise<boolean>
}

export type SelectMenuEvent = BaseInteractionEvent & {
  customId: string
  message: PlatformMessage
  values: string[]
  reply(options: LegacyReplyOptions): Promise<void>
  replyUi(message: OutgoingMessage): Promise<void>
  deferReply(options?: PlatformDeferReplyOptions): Promise<void>
  editReply(options: LegacyEditReplyOptions): Promise<void>
  editUiReply(message: OutgoingMessage): Promise<void>
  deferUpdate(options?: { withResponse?: boolean }): Promise<void>
  update(options: LegacyUpdateOptions): Promise<void>
  updateUi(message: OutgoingMessage): Promise<void>
  showModal(modal: UiModal): Promise<void>
}

export type ModalSubmitEvent = BaseInteractionEvent & {
  customId: string
  fields: PlatformModalFields
  reply(options: LegacyReplyOptions): Promise<void>
  replyUi(message: OutgoingMessage): Promise<void>
  deferReply(options?: PlatformDeferReplyOptions): Promise<void>
  editReply(options: LegacyEditReplyOptions): Promise<void>
  editUiReply(message: OutgoingMessage): Promise<void>
}

export interface KimakiAdapter {
  readonly name: string

  readonly admin?: PlatformAdmin

  readonly content: {
    resolveMentions(message: PlatformMessage): Promise<string>
    getTextAttachments(message: PlatformMessage): Promise<string>
    getFileAttachments(message: PlatformMessage): Promise<PlatformFileAttachment[]>
  }

  readonly permissions: {
    getMessageAccess(message: PlatformMessage): Promise<MessageAccess>
  }

  readonly voice?: {
    processAttachment(input: {
      message: PlatformMessage
      thread: PlatformThread
      projectDirectory?: string
      isNewThread?: boolean
      appId?: string
      currentSessionContext?: string
      lastSessionContext?: string
    }): Promise<TranscriptionResult | null>
  }

  login(token: string): Promise<void>
  destroy(): void
  conversation(target: MessageTarget): PlatformConversation
  channel(channelId: string): Promise<PlatformChannelHandle | null>
  thread(input: {
    threadId: string
    parentId?: string | null
  }): Promise<PlatformThreadHandle | null>

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
