// Actions (spec 27.2): the only module that writes to OpenCode and creates
// session threads. Callers (ingress now; slash commands, CLI and scheduler in
// later phases) get an ack back. Session output is never rendered here: it
// arrives through the event stream.

import { ChannelType, type Client } from 'discord.js'

import type { KimakiDb } from './db.ts'
import { DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError } from './errors.ts'
import type { EventLoop } from './event-loop.ts'
import { createLogger } from './logger.ts'
import type { OpencodeConnection } from './opencode-server.ts'
import * as schema from './schema.ts'
import { baseInstructions, INSTRUCTION_KEY, turnContext } from './system-prompt.ts'

const logger = createLogger('ACTIONS')

export type Author = { id: string; username: string }

// Prompt IDs map a Discord message to its inbox item without stored state (spec 9.2.2).
export function promptIdForMessage(messageId: string): string {
  return `msg_discord_${messageId}`
}

function parseModel(value: string | null | undefined, variant: string | null | undefined) {
  if (!value) return null
  const slash = value.indexOf('/')
  if (slash <= 0) return null
  return {
    providerID: value.slice(0, slash),
    id: value.slice(slash + 1),
    ...(variant && { variant }),
  }
}

export function createActions({
  discord,
  db,
  opencode,
  eventLoop,
}: {
  discord: Client
  db: KimakiDb
  opencode: OpencodeConnection
  eventLoop: EventLoop
}) {
  function client() {
    const endpoint = opencode.endpoint
    if (!endpoint) return new OpenCodeUnavailableError({ reason: 'not connected' })
    return endpoint.client
  }

  async function send({
    threadId,
    threadName,
    sessionId,
    text,
    author,
    messageId,
  }: {
    threadId: string
    threadName: string
    sessionId: string
    text: string
    author: Author
    messageId: string
  }): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const context = turnContext({ username: author.username, userId: author.id, messageId, threadId, threadName })
    const result = await opencodeClient.session
      .prompt({
        sessionID: sessionId,
        id: promptIdForMessage(messageId),
        text: `${text}\n\n${context}`,
        delivery: 'steer',
        metadata: { discord: { userId: author.id, username: author.username, messageId, threadId } },
      })
      .catch((e) => new OpenCodeError({ operation: 'session.prompt', cause: e }))
    if (result instanceof Error) return result
  }

  async function startSession({
    channelId,
    directory,
    text,
    author,
    messageId,
  }: {
    channelId: string
    directory: string
    text: string
    author: Author
    messageId: string
  }): Promise<
    OpenCodeUnavailableError | OpenCodeError | DiscordError | DbError | { threadId: string; sessionId: string }
  > {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient

    const channel = await discord.channels
      .fetch(channelId)
      .catch((e) => new DiscordError({ operation: `fetch channel ${channelId}`, cause: e }))
    if (channel instanceof Error) return channel
    if (channel?.type !== ChannelType.GuildText) {
      return new DiscordError({ operation: `start thread in non-text channel ${channelId}` })
    }
    const threadName = text.replace(/\s+/g, ' ').slice(0, 80) || 'Kimaki session'
    const thread = await channel.threads
      .create({ name: threadName, startMessage: messageId, autoArchiveDuration: 1440 })
      .catch((e) => new DiscordError({ operation: 'create thread', cause: e }))
    if (thread instanceof Error) return thread

    const defaults = await db.query.channel_directories
      .findFirst({ where: { channel_id: channelId }, with: { channel_model: true, channel_agent: true } })
      .catch((e) => new DbError({ operation: 'read channel defaults', cause: e }))
    if (defaults instanceof Error) return defaults
    const model = parseModel(defaults?.channel_model?.model_id, defaults?.channel_model?.variant)
    const channelAgent = defaults?.channel_agent

    const session = await opencodeClient.session
      .create({
        title: threadName,
        location: { directory },
        ...(model && { model }),
        ...(channelAgent && { agent: channelAgent.agent_name }),
        metadata: { kimaki: { threadId: thread.id, channelId, source: 'discord' } },
      })
      .catch((e) => new OpenCodeError({ operation: 'session.create', cause: e }))
    if (session instanceof Error) return session

    const instructions = await opencodeClient.session.instructions.entry
      .put({
        sessionID: session.id,
        key: INSTRUCTION_KEY,
        value: baseInstructions({ sessionId: session.id, threadId: thread.id, channelId, guildId: channel.guildId }),
      })
      .catch((e) => new OpenCodeError({ operation: 'instructions.entry.put', cause: e }))
    if (instructions instanceof Error) return instructions

    const inserted = await db
      .insert(schema.thread_sessions)
      .values({ thread_id: thread.id, session_id: session.id, source: 'kimaki' })
      .catch((e) => new DbError({ operation: 'insert thread_sessions', cause: e }))
    if (inserted instanceof Error) return inserted
    eventLoop.bind({ threadId: thread.id, sessionId: session.id, channelId, directory })
    logger.log(`session ${session.id} bound to thread ${thread.id}`)

    const sent = await send({ threadId: thread.id, threadName, sessionId: session.id, text, author, messageId })
    if (sent instanceof Error) return sent
    return { threadId: thread.id, sessionId: session.id }
  }

  return { startSession, send }
}

export type Actions = ReturnType<typeof createActions>
