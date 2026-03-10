// Slack adapter for Kimaki's platform interface.
// Owns Slack Web API message/thread operations and stores webhook-dispatched
// callback handlers for Slack messages, commands, buttons, selects, and modals.

import { WebClient, type ChatPostMessageArguments } from '@slack/web-api'
import type {
  AutocompleteEvent,
  ButtonEvent,
  CommandEvent,
  IncomingMessageEvent,
  IncomingThreadEvent,
  KimakiAdapter,
  MessageTarget,
  ModalSubmitEvent,
  OutgoingMessage,
  PlatformAdmin,
  PlatformMessage,
  PlatformThread,
  SelectMenuEvent,
  UiModal,
} from './types.js'
import { renderSlackMessage } from './slack-markdown.js'

type SlackFile = {
  id?: string
  mimetype?: string
  name?: string
  url_private?: string
}

type SlackApiMessage = {
  bot_id?: string
  channel?: string
  files?: SlackFile[]
  text?: string
  thread_ts?: string
  ts?: string
  user?: string
  username?: string
}

type SlackInteractiveUser = {
  id: string
  username?: string
  name?: string
}

export type SlackIncomingMessagePayload = {
  bot_id?: string
  channel: string
  files?: SlackFile[]
  subtype?: string
  text?: string
  thread_ts?: string
  ts: string
  type: 'app_mention' | 'message'
  user?: string
  username?: string
}

export type SlackThreadPayload = {
  channelId: string
  newlyCreated: boolean
  threadId: string
  threadName?: string
}

type SlackBlockAction = {
  action_id: string
  selected_option?: { value: string }
  selected_options?: Array<{ value: string }>
  type: string
  value?: string
}

export type SlackBlockActionsPayload = {
  actions: SlackBlockAction[]
  channel?: { id: string }
  container?: {
    channel_id?: string
    message_ts?: string
    thread_ts?: string
  }
  message?: {
    text?: string
    thread_ts?: string
    ts?: string
  }
  response_url?: string
  trigger_id?: string
  user: SlackInteractiveUser
}

export type SlackViewSubmissionPayload = {
  trigger_id?: string
  user: SlackInteractiveUser
  view: {
    callback_id: string
    id: string
    private_metadata?: string
    state: {
      values: Record<
        string,
        Record<
          string,
          {
            selected_option?: { value: string }
            selected_options?: Array<{ value: string }>
            value?: string
          }
        >
      >
    }
  }
}

export type SlackSlashCommandPayload = {
  channel_id: string
  command: string
  response_url?: string
  text?: string
  trigger_id?: string
  user_id: string
  user_name?: string
}

type SlackReplyOptions = {
  content?: string
  flags?: number
}

type SlackInteractionContext = {
  channelId: string
  messageTs?: string
  responseUrl?: string
  threadId?: string
  triggerId?: string
  user: SlackInteractiveUser
}

export type SlackCommandEvent = {
  raw: SlackSlashCommandPayload
  appId: string
  commandName: string
  channelId: string
  responseUrl?: string
  text: string
  triggerId?: string
  user: {
    id: string
    username: string
    displayName: string
  }
  reply(options: string | SlackReplyOptions): Promise<void>
  replyUi(message: OutgoingMessage): Promise<void>
  editReply(options: string | SlackReplyOptions): Promise<void>
  editUiReply(message: OutgoingMessage): Promise<void>
  showModal(modal: UiModal): Promise<void>
}

export type SlackButtonEvent = {
  raw: SlackBlockActionsPayload
  appId: string
  customId: string
  channelId: string
  messageTs?: string
  responseUrl?: string
  threadId?: string
  triggerId?: string
  user: {
    id: string
    username: string
    displayName: string
  }
  reply(options: string | SlackReplyOptions): Promise<void>
  replyUi(message: OutgoingMessage): Promise<void>
  editReply(options: string | SlackReplyOptions): Promise<void>
  editUiReply(message: OutgoingMessage): Promise<void>
  followUp(options: string | SlackReplyOptions): Promise<void>
  update(options: string | SlackReplyOptions): Promise<void>
  updateUi(message: OutgoingMessage): Promise<void>
  showModal(modal: UiModal): Promise<void>
}

export type SlackSelectMenuEvent = SlackButtonEvent & {
  values: string[]
}

export type SlackModalSubmitEvent = {
  raw: SlackViewSubmissionPayload
  appId: string
  channelId: string | null
  customId: string
  triggerId?: string
  user: {
    id: string
    username: string
    displayName: string
  }
  values: Record<string, string[]>
  fields: {
    getTextInputValue(id: string): string
  }
  reply(options: string | SlackReplyOptions): Promise<void>
  replyUi(message: OutgoingMessage): Promise<void>
  editReply(options: string | SlackReplyOptions): Promise<void>
  editUiReply(message: OutgoingMessage): Promise<void>
}

function normalizeReplyText(options: string | SlackReplyOptions) {
  if (typeof options === 'string') {
    return options
  }
  return options.content || ''
}

function wrapSlackUser(user: {
  bot?: boolean
  id: string
  username?: string
  displayName?: string
}) {
  const username = user.displayName || user.username || user.id
  return {
    id: user.id,
    username,
    displayName: username,
    globalName: user.displayName || user.username || user.id,
    bot: user.bot ?? false,
  }
}

function normalizeReactionName(emoji: string) {
  const trimmed = emoji.trim()
  if (trimmed.startsWith(':') && trimmed.endsWith(':')) {
    return trimmed.slice(1, -1)
  }
  if (/^[a-z0-9_+-]+$/i.test(trimmed)) {
    return trimmed
  }
  if (trimmed === '🌳') {
    return 'deciduous_tree'
  }
  return trimmed
}

function flattenModalValues(payload: SlackViewSubmissionPayload) {
  const values: Record<string, string[]> = {}
  for (const blockValues of Object.values(payload.view.state.values)) {
    for (const [actionId, input] of Object.entries(blockValues)) {
      const currentValues = [
        ...(input.value ? [input.value] : []),
        ...(input.selected_option?.value ? [input.selected_option.value] : []),
        ...(input.selected_options || []).map((option) => {
          return option.value
        }),
      ]
      values[actionId] = currentValues
    }
  }
  return values
}

function getModalMetadataValue({
  privateMetadata,
  key,
}: {
  privateMetadata?: string
  key: string
}) {
  if (!privateMetadata) {
    return undefined
  }
  const params = new URLSearchParams(privateMetadata)
  return params.get(key) || undefined
}

function wrapSlackMessage(message: SlackApiMessage): PlatformMessage {
  if (!message.ts || !message.channel) {
    throw new Error('Slack message is missing ts or channel')
  }
  return {
    id: message.ts,
    content: message.text || null,
    channelId: message.channel,
    author: {
      id: message.user || message.bot_id || 'unknown',
      username: message.username || message.user || message.bot_id || 'unknown',
      displayName: message.username || message.user || message.bot_id || 'unknown',
      globalName: message.username || message.user || message.bot_id || 'unknown',
      bot: Boolean(message.bot_id),
    },
    attachments: new Map(
      (message.files || []).flatMap((file) => {
        if (!file.id || !file.url_private) {
          return []
        }
        return [
          [
            file.id,
            {
              url: file.url_private,
              contentType: file.mimetype,
              name: file.name,
            },
          ],
        ]
      }),
    ),
    embeds: [],
  }
}

function wrapSlackThread(input: {
  channelId: string
  threadId: string
  name: string
}): PlatformThread {
  return {
    id: input.threadId,
    name: input.name,
    kind: 'thread',
    type: 'thread',
    parentId: input.channelId,
    guildId: null,
    isThread() {
      return true
    },
  }
}

function createSlackModalView({
  channelId,
  modal,
  threadId,
}: {
  channelId: string
  modal: UiModal
  threadId?: string
}) {
  const privateMetadata = new URLSearchParams({
    channelId,
    ...(threadId ? { threadId } : {}),
  }).toString()
  return {
    type: 'modal' as const,
    callback_id: modal.id,
    private_metadata: privateMetadata,
    title: {
      type: 'plain_text' as const,
      text: modal.title.slice(0, 24),
      emoji: true,
    },
    submit: {
      type: 'plain_text' as const,
      text: 'Submit',
      emoji: true,
    },
    close: {
      type: 'plain_text' as const,
      text: 'Cancel',
      emoji: true,
    },
    blocks: modal.inputs.map((input) => {
      if (input.type === 'text') {
        return {
          type: 'input' as const,
          block_id: input.id,
          label: {
            type: 'plain_text' as const,
            text: input.label.slice(0, 200),
            emoji: true,
          },
          optional: !(input.required ?? true),
          element: {
            type: input.style === 'paragraph' ? 'plain_text_input' : 'plain_text_input',
            action_id: input.id,
            multiline: input.style === 'paragraph',
            placeholder: input.placeholder
              ? {
                  type: 'plain_text' as const,
                  text: input.placeholder.slice(0, 150),
                  emoji: true,
                }
              : undefined,
          },
        }
      }
      return {
        type: 'input' as const,
        block_id: input.id,
        label: {
          type: 'plain_text' as const,
          text: input.label.slice(0, 200),
          emoji: true,
        },
        optional: false,
        hint: input.description
          ? {
              type: 'plain_text' as const,
              text: input.description.slice(0, 150),
              emoji: true,
            }
          : undefined,
        element: {
          type: 'file_input' as const,
          action_id: input.id,
          max_files: input.maxFiles,
        },
      }
    }),
  }
}

export class SlackAdapter implements KimakiAdapter {
  readonly name = 'slack'
  readonly admin: PlatformAdmin = {
    listGuilds: async () => {
      return []
    },
    resolveGuild: async () => {
      return null
    },
    registerCommands: async () => {
      throw new Error('Slack adapter does not support Discord slash command registration')
    },
    ensureGuildAccessPolicy: async () => {},
    listChannels: async () => {
      return []
    },
    createCategory: async () => {
      throw new Error('Slack adapter does not support guild category creation')
    },
    createTextChannel: async () => {
      throw new Error('Slack adapter does not support guild text channel creation')
    },
    fetchChannel: async () => {
      return null
    },
    fetchChannelById: async () => {
      return null
    },
    deleteChannel: async () => {
      return 'missing'
    },
    listGuildMembers: async () => {
      return []
    },
    searchGuildMembers: async () => {
      return []
    },
  }
  readonly content = {
    resolveMentions: async (message: PlatformMessage) => {
      return message.content || ''
    },
    getTextAttachments: async (_message: PlatformMessage) => {
      return ''
    },
    getFileAttachments: async (_message: PlatformMessage) => {
      return []
    },
  }
  readonly permissions = {
    getMessageAccess: async () => {
      return 'allowed' as const
    },
  }
  client: WebClient
  private appId = 'slack'
  private botUserId?: string
  private readonly threadChannelIds = new Map<string, string>()
  private readonly readyHandlers: Array<() => void> = []
  private readonly messageHandlers: Array<
    (event: IncomingMessageEvent) => void | Promise<void>
  > = []
  private readonly threadCreateHandlers: Array<
    (event: IncomingThreadEvent) => void | Promise<void>
  > = []
  private readonly threadDeleteHandlers: Array<(threadId: string) => void> = []
  private readonly commandHandlers: Array<
    (event: CommandEvent) => void | Promise<void>
  > = []
  private readonly autocompleteHandlers: Array<
    (event: AutocompleteEvent) => void | Promise<void>
  > = []
  private readonly buttonHandlers: Array<(event: ButtonEvent) => void | Promise<void>> = []
  private readonly selectMenuHandlers: Array<
    (event: SelectMenuEvent) => void | Promise<void>
  > = []
  private readonly modalSubmitHandlers: Array<
    (event: ModalSubmitEvent) => void | Promise<void>
  > = []
  private readonly errorHandlers: Array<(error: Error) => void> = []

  constructor({ client }: { client?: WebClient } = {}) {
    this.client = client || new WebClient()
  }

  async login(token: string) {
    this.client = new WebClient(token)
    const auth = await this.client.auth.test()
    this.botUserId = auth.user_id || undefined
    this.appId = auth.bot_id || auth.team_id || 'slack'
    await this.emitReady()
  }

  destroy() {}

  conversation(target: MessageTarget) {
    return {
      target,
      send: async (message: OutgoingMessage) => {
        return this.postUiMessage({
          channelId: target.channelId,
          message,
          threadId: target.threadId || message.replyToMessageId,
        })
      },
      update: async (messageId: string, message: OutgoingMessage) => {
        await this.updateUiMessage({
          channelId: target.channelId,
          message,
          messageId,
        })
      },
      delete: async (messageId: string) => {
        await this.client.chat.delete({ channel: target.channelId, ts: messageId })
      },
      message: async (messageId: string) => {
        const data = await this.fetchMessage(target, messageId)
        return {
          data,
          startThread: async ({
            name,
            autoArchiveDuration,
            reason,
          }: {
            name: string
            autoArchiveDuration: number
            reason: string
          }) => {
            return this.createThreadFromMessage({
              message: data,
              name,
              autoArchiveDuration,
              reason,
            })
          },
        }
      },
      startTyping: async () => {},
    }
  }

  async channel(channelId: string) {
    return {
      data: {
        id: channelId,
        kind: 'text' as const,
        type: 'text' as const,
        parentId: null,
        guildId: null,
        isThread() {
          return false
        },
      },
      conversation: () => {
        return this.conversation({ channelId })
      },
    }
  }

  async thread({ threadId, parentId }: { threadId: string; parentId?: string | null }) {
    const channelId = parentId || this.threadChannelIds.get(threadId)
    if (!channelId) {
      return null
    }
    const data = wrapSlackThread({ channelId, threadId, name: threadId })
    return {
      data,
      conversation: () => {
        return this.conversation({ channelId, threadId })
      },
      message: async (messageId: string) => {
        return this.conversation({ channelId, threadId }).message(messageId)
      },
      starterMessage: async () => {
        return this.fetchStarterMessage(threadId)
      },
      rename: async (_name: string) => {},
      archive: async () => {},
      addMember: async (_userId: string) => {},
      addStarterReaction: async (emoji: string) => {
        await this.addThreadStarterReaction({ channelId, threadId }, emoji)
      },
      reference: () => {
        return `#${threadId}`
      },
    }
  }

  private rememberThread({ channelId, threadId }: { channelId: string; threadId: string }) {
    this.threadChannelIds.set(threadId, channelId)
  }

  private async emitReady() {
    for (const handler of this.readyHandlers) {
      try {
        await handler()
      } catch (error) {
        this.emitError(error)
      }
    }
  }

  private emitError(error: unknown) {
    const normalizedError = error instanceof Error ? error : new Error(String(error))
    for (const handler of this.errorHandlers) {
      handler(normalizedError)
    }
  }

  private async postUiMessage({
    channelId,
    message,
    threadId,
  }: {
    channelId: string
    message: OutgoingMessage
    threadId?: string
  }) {
    const rendered = renderSlackMessage(message)
    const response = await this.client.chat.postMessage({
      channel: channelId,
      text: rendered.text,
      blocks: rendered.blocks,
      thread_ts: threadId,
    })
    if (!response.ts) {
      throw new Error('Slack postMessage did not return a timestamp')
    }
    if (threadId) {
      this.rememberThread({ channelId, threadId })
    }
    return { id: response.ts }
  }

  private async updateUiMessage({
    channelId,
    message,
    messageId,
  }: {
    channelId: string
    message: OutgoingMessage
    messageId: string
  }) {
    const rendered = renderSlackMessage(message)
    await this.client.chat.update({
      channel: channelId,
      ts: messageId,
      text: rendered.text,
      blocks: rendered.blocks,
    })
  }

  async fetchMessage(target: MessageTarget, messageId: string) {
    if (target.threadId && target.threadId !== messageId) {
      const replies = await this.client.conversations.replies({
        channel: target.channelId,
        ts: target.threadId,
        inclusive: true,
        latest: messageId,
        oldest: messageId,
      })
      const message = replies.messages?.find((candidate) => {
        return candidate.ts === messageId
      })
      if (!message) {
        throw new Error(`Slack message not found: ${messageId}`)
      }
      this.rememberThread({ channelId: target.channelId, threadId: target.threadId })
      return wrapSlackMessage(message as SlackApiMessage)
    }

    const history = await this.client.conversations.history({
      channel: target.channelId,
      inclusive: true,
      latest: messageId,
      oldest: messageId,
      limit: 1,
    })
    const message = history.messages?.[0]
    if (!message) {
      throw new Error(`Slack message not found: ${messageId}`)
    }
    return wrapSlackMessage({
      ...(message as SlackApiMessage),
      channel: target.channelId,
    })
  }

  async startTyping(_target: MessageTarget) {}

  async renameThread(_threadId: string, _name: string) {}

  async createThreadFromMessage(input: {
    message: PlatformMessage
    name: string
    autoArchiveDuration: number
    reason: string
  }) {
    const rootTs = input.message.id
    const channelId = input.message.channelId

    await this.postUiMessage({
      channelId,
      threadId: rootTs,
      message: {
        markdown: input.name,
      },
    })

    this.rememberThread({ channelId, threadId: rootTs })
    return {
      thread: wrapSlackThread({
        channelId,
        threadId: rootTs,
        name: input.name,
      }),
      target: {
        channelId,
        threadId: rootTs,
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
    const message = await this.fetchMessage({ channelId: input.channelId }, input.messageId)
    return this.createThreadFromMessage({
      message,
      name: input.name,
      autoArchiveDuration: input.autoArchiveDuration,
      reason: input.reason,
    })
  }

  async addThreadMember(_threadId: string, _userId: string) {}

  async addThreadStarterReaction(
    input: { channelId: string; threadId: string },
    emoji: string,
  ) {
    this.rememberThread({ channelId: input.channelId, threadId: input.threadId })
    await this.client.reactions.add({
      channel: input.channelId,
      name: normalizeReactionName(emoji),
      timestamp: input.threadId,
    })
  }

  async fetchStarterMessage(threadId: string) {
    const channelId = this.threadChannelIds.get(threadId)
    if (!channelId) {
      return null
    }
    const replies = await this.client.conversations.replies({
      channel: channelId,
      ts: threadId,
      inclusive: true,
      latest: threadId,
      oldest: threadId,
    })
    const starter = replies.messages?.find((message) => {
      return message.ts === threadId
    })
    if (!starter) {
      return null
    }
    return wrapSlackMessage({
      ...(starter as SlackApiMessage),
      channel: channelId,
    })
  }

  onReady(handler: () => void) {
    this.readyHandlers.push(handler)
  }

  onMessage(handler: (event: IncomingMessageEvent) => void | Promise<void>) {
    this.messageHandlers.push(handler)
  }

  onThreadCreate(handler: (event: IncomingThreadEvent) => void | Promise<void>) {
    this.threadCreateHandlers.push(handler)
  }

  onThreadDelete(handler: (threadId: string) => void) {
    this.threadDeleteHandlers.push(handler)
  }

  onCommand(handler: (event: CommandEvent) => void | Promise<void>) {
    this.commandHandlers.push(handler)
  }

  onAutocomplete(handler: (event: AutocompleteEvent) => void | Promise<void>) {
    this.autocompleteHandlers.push(handler)
  }

  onButton(handler: (event: ButtonEvent) => void | Promise<void>) {
    this.buttonHandlers.push(handler)
  }

  onSelectMenu(handler: (event: SelectMenuEvent) => void | Promise<void>) {
    this.selectMenuHandlers.push(handler)
  }

  onModalSubmit(handler: (event: ModalSubmitEvent) => void | Promise<void>) {
    this.modalSubmitHandlers.push(handler)
  }

  onError(handler: (error: Error) => void) {
    this.errorHandlers.push(handler)
  }

  // TODO: Verify forwarded Slack webhook requests with the planned JWT-like
  // gateway token before dispatching any stored handlers.
  async dispatchIncomingMessage(payload: SlackIncomingMessagePayload) {
    if (payload.thread_ts) {
      this.rememberThread({ channelId: payload.channel, threadId: payload.thread_ts })
    }
    const target = payload.thread_ts
      ? { channelId: payload.channel, threadId: payload.thread_ts }
      : { channelId: payload.channel }
    const isMention =
      payload.type === 'app_mention' ||
      Boolean(this.botUserId && payload.text?.includes(`<@${this.botUserId}>`))
    const event: IncomingMessageEvent = {
      message: wrapSlackMessage({
        ...payload,
        channel: payload.channel,
      }),
      conversation: this.conversation(target),
      thread: payload.thread_ts
        ? wrapSlackThread({
            channelId: payload.channel,
            threadId: payload.thread_ts,
            name: payload.thread_ts,
          })
        : undefined,
      kind: payload.thread_ts ? 'thread' : 'channel',
      isMention,
    }

    for (const handler of this.messageHandlers) {
      try {
        await handler(event)
      } catch (error) {
        this.emitError(error)
      }
    }
  }

  async dispatchThreadCreate(payload: SlackThreadPayload) {
    this.rememberThread({ channelId: payload.channelId, threadId: payload.threadId })
    const thread = wrapSlackThread({
      channelId: payload.channelId,
      threadId: payload.threadId,
      name: payload.threadName || payload.threadId,
    })
    const threadHandle = await this.thread({
      threadId: payload.threadId,
      parentId: payload.channelId,
    })
    if (!threadHandle) {
      throw new Error(`Slack thread not found: ${payload.threadId}`)
    }
    const event: IncomingThreadEvent = {
      thread,
      threadHandle,
      conversation: this.conversation({
        channelId: payload.channelId,
        threadId: payload.threadId,
      }),
      newlyCreated: payload.newlyCreated,
    }

    for (const handler of this.threadCreateHandlers) {
      try {
        await handler(event)
      } catch (error) {
        this.emitError(error)
      }
    }
  }

  dispatchThreadDelete(threadId: string) {
    this.threadChannelIds.delete(threadId)
    for (const handler of this.threadDeleteHandlers) {
      try {
        handler(threadId)
      } catch (error) {
        this.emitError(error)
      }
    }
  }

  private async replyFromContext({
    context,
    options,
  }: {
    context: SlackInteractionContext
    options: string | SlackReplyOptions
  }) {
    await this.postUiMessage({
      channelId: context.channelId,
      threadId: context.threadId,
      message: {
        markdown: normalizeReplyText(options),
      },
    })
  }

  private async editFromContext({
    context,
    options,
  }: {
    context: SlackInteractionContext
    options: string | SlackReplyOptions
  }) {
    if (!context.messageTs) {
      await this.replyFromContext({ context, options })
      return
    }
    await this.client.chat.update({
      channel: context.channelId,
      ts: context.messageTs,
      text: normalizeReplyText(options),
    })
  }

  private async showModalFromContext({
    context,
    modal,
  }: {
    context: SlackInteractionContext
    modal: UiModal
  }) {
    if (!context.triggerId) {
      throw new Error('Slack modal requires a trigger ID')
    }
    await this.client.views.open({
      trigger_id: context.triggerId,
      view: createSlackModalView({
        channelId: context.channelId,
        modal,
        threadId: context.threadId,
      }),
    })
  }

  private createInteractionContextFromActions(payload: SlackBlockActionsPayload) {
    const channelId = payload.channel?.id || payload.container?.channel_id
    if (!channelId) {
      throw new Error('Slack block action is missing a channel ID')
    }
    const threadId = payload.message?.thread_ts || payload.container?.thread_ts
    if (threadId) {
      this.rememberThread({ channelId, threadId })
    }
    return {
      channelId,
      messageTs: payload.message?.ts || payload.container?.message_ts,
      responseUrl: payload.response_url,
      threadId,
      triggerId: payload.trigger_id,
      user: payload.user,
    }
  }

  async dispatchBlockActions(payload: SlackBlockActionsPayload) {
    const context = this.createInteractionContextFromActions(payload)
    for (const action of payload.actions) {
      const shared = {
        raw: payload,
        appId: this.appId,
        channelId: context.channelId,
        messageTs: context.messageTs,
        responseUrl: context.responseUrl,
        threadId: context.threadId,
        triggerId: context.triggerId,
        user: wrapSlackUser({
          id: payload.user.id,
          username: payload.user.username || payload.user.name || payload.user.id,
          displayName: payload.user.name || payload.user.username || payload.user.id,
        }),
        reply: async (options: string | SlackReplyOptions) => {
          await this.replyFromContext({ context, options })
        },
        replyUi: async (message: OutgoingMessage) => {
          await this.postUiMessage({
            channelId: context.channelId,
            threadId: context.threadId,
            message,
          })
        },
        editReply: async (options: string | SlackReplyOptions) => {
          await this.editFromContext({ context, options })
        },
        editUiReply: async (message: OutgoingMessage) => {
          if (!context.messageTs) {
            await this.postUiMessage({
              channelId: context.channelId,
              threadId: context.threadId,
              message,
            })
            return
          }
          await this.updateUiMessage({
            channelId: context.channelId,
            message,
            messageId: context.messageTs,
          })
        },
        followUp: async (options: string | SlackReplyOptions) => {
          await this.replyFromContext({ context, options })
        },
        update: async (options: string | SlackReplyOptions) => {
          await this.editFromContext({ context, options })
        },
        updateUi: async (message: OutgoingMessage) => {
          if (!context.messageTs) {
            await this.postUiMessage({
              channelId: context.channelId,
              threadId: context.threadId,
              message,
            })
            return
          }
          await this.updateUiMessage({
            channelId: context.channelId,
            message,
            messageId: context.messageTs,
          })
        },
        showModal: async (modal: UiModal) => {
          await this.showModalFromContext({ context, modal })
        },
      }
      if (action.type === 'static_select' || action.type === 'multi_static_select') {
        const event: SlackSelectMenuEvent = {
          ...shared,
          customId: action.action_id,
          values: [
            ...(action.selected_option?.value ? [action.selected_option.value] : []),
            ...(action.selected_options || []).map((option) => {
              return option.value
            }),
          ],
        }
        for (const handler of this.selectMenuHandlers) {
          try {
            await handler(event as unknown as SelectMenuEvent)
          } catch (error) {
            this.emitError(error)
          }
        }
        continue
      }

      const event: SlackButtonEvent = {
        ...shared,
        customId: action.action_id,
      }
      for (const handler of this.buttonHandlers) {
        try {
          await handler(event as unknown as ButtonEvent)
        } catch (error) {
          this.emitError(error)
        }
      }
    }
  }

  async dispatchModalSubmit(payload: SlackViewSubmissionPayload) {
    const values = flattenModalValues(payload)
    const channelId = getModalMetadataValue({
      privateMetadata: payload.view.private_metadata,
      key: 'channelId',
    })
    const threadId = getModalMetadataValue({
      privateMetadata: payload.view.private_metadata,
      key: 'threadId',
    })
    if (channelId && threadId) {
      this.rememberThread({ channelId, threadId })
    }
    const context: SlackInteractionContext = {
      channelId: channelId || payload.user.id,
      threadId,
      triggerId: payload.trigger_id,
      user: payload.user,
    }
    const event: SlackModalSubmitEvent = {
      raw: payload,
      appId: this.appId,
      channelId: channelId || null,
      customId: payload.view.callback_id,
      triggerId: payload.trigger_id,
      user: wrapSlackUser({
        id: payload.user.id,
        username: payload.user.username || payload.user.name || payload.user.id,
        displayName: payload.user.name || payload.user.username || payload.user.id,
      }),
      values,
      fields: {
        getTextInputValue: (id: string) => {
          return values[id]?.[0] || ''
        },
      },
      reply: async (options: string | SlackReplyOptions) => {
        await this.replyFromContext({ context, options })
      },
      replyUi: async (message: OutgoingMessage) => {
        await this.postUiMessage({
          channelId: context.channelId,
          threadId: context.threadId,
          message,
        })
      },
      editReply: async (options: string | SlackReplyOptions) => {
        await this.replyFromContext({ context, options })
      },
      editUiReply: async (message: OutgoingMessage) => {
        await this.postUiMessage({
          channelId: context.channelId,
          threadId: context.threadId,
          message,
        })
      },
    }
    for (const handler of this.modalSubmitHandlers) {
      try {
        await handler(event as unknown as ModalSubmitEvent)
      } catch (error) {
        this.emitError(error)
      }
    }
  }

  async dispatchCommand(payload: SlackSlashCommandPayload) {
    const context: SlackInteractionContext = {
      channelId: payload.channel_id,
      responseUrl: payload.response_url,
      triggerId: payload.trigger_id,
      user: {
        id: payload.user_id,
        username: payload.user_name || payload.user_id,
        name: payload.user_name || payload.user_id,
      },
    }
    const commandName = payload.command.replace(/^\//, '')
    const event: SlackCommandEvent = {
      raw: payload,
      appId: this.appId,
      commandName,
      channelId: payload.channel_id,
      responseUrl: payload.response_url,
      text: payload.text || '',
      triggerId: payload.trigger_id,
      user: wrapSlackUser({
        id: payload.user_id,
        username: payload.user_name || payload.user_id,
        displayName: payload.user_name || payload.user_id,
      }),
      reply: async (options: string | SlackReplyOptions) => {
        await this.replyFromContext({ context, options })
      },
      replyUi: async (message: OutgoingMessage) => {
        await this.postUiMessage({
          channelId: context.channelId,
          message,
        })
      },
      editReply: async (options: string | SlackReplyOptions) => {
        await this.replyFromContext({ context, options })
      },
      editUiReply: async (message: OutgoingMessage) => {
        await this.postUiMessage({
          channelId: context.channelId,
          message,
        })
      },
      showModal: async (modal: UiModal) => {
        await this.showModalFromContext({ context, modal })
      },
    }
    for (const handler of this.commandHandlers) {
      try {
        await handler(event as unknown as CommandEvent)
      } catch (error) {
        this.emitError(error)
      }
    }
  }
}

export async function createSlackAdapter({
  client,
}: {
  client?: WebClient
} = {}) {
  return new SlackAdapter({ client })
}
