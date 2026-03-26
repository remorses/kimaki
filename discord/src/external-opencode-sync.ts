import fs from 'node:fs'
import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type Client,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type {
  OpencodeClient,
  Part,
} from '@opencode-ai/sdk/v2'
import {
  getChannelVerbosity,
  getPartMessageIds,
  getThreadIdBySessionId,
  getThreadSessionSource,
  listTrackedTextChannels,
  setPartMessagesBatch,
  upsertThreadSession,
} from './database.js'
import { sendThreadMessage } from './discord-utils.js'
import { createLogger, LogPrefix } from './logger.js'
import {
  formatPart,
  collectSessionChunks,
  batchChunksForDiscord,
  type SessionChunk,
} from './message-formatting.js'
import {
  initializeOpencodeForDirectory,
} from './opencode.js'
import { isEssentialToolPart } from './session-handler/thread-session-runtime.js'
import { notifyError } from './sentry.js'
import { extractNonXmlContent } from './xml.js'


const logger = createLogger(LogPrefix.OPENCODE)

const EXTERNAL_SYNC_INTERVAL_MS = 5_000
const EXTERNAL_SYNC_MAX_SESSIONS = 25
// Don't sync sessions from before the CLI started. 5 min grace window
// covers sessions that were just created before the bot connected.
const CLI_START_MS = Date.now() - 5 * 60 * 1000

type RenderableUserTextPart = {
  id: string
  text: string
}

type SessionMessagesResponse = Awaited<
  ReturnType<OpencodeClient['session']['messages']>
>
type SessionMessage = NonNullable<SessionMessagesResponse['data']>[number]
type SessionMessageLike = {
  info: {
    role: string
  }
  parts: Part[]
}

type DiscordOriginMetadata = {
  messageId: string
  username: string
  threadId?: string
}

type TrackedTextChannelRow = Awaited<ReturnType<typeof listTrackedTextChannels>>[number]

type DirectorySyncTarget = {
  directory: string
  channelId: string
  startMs: number
}

type ListedSession = NonNullable<
  Awaited<ReturnType<OpencodeClient['session']['list']>>['data']
>[number]

let externalSyncInterval: ReturnType<typeof setInterval> | null = null

function isSyntheticTextPart(part: Extract<Part, { type: 'text' }>): boolean {
  const candidate = part as Extract<Part, { type: 'text' }> & {
    synthetic?: unknown
  }
  return candidate.synthetic === true
}

function parseDiscordOriginMetadata(text: string): DiscordOriginMetadata | null {
  const match = text.match(/^<discord-user\s+([^>]+)\s*\/>$/)
  if (!match?.[1]) {
    return null
  }
  const attrs = [...match[1].matchAll(/([a-z-]+)="([^"]*)"/g)].reduce(
    (acc, current) => {
      const [, key, value] = current
      if (!key) {
        return acc
      }
      acc[key] = value || ''
      return acc
    },
    {} as Record<string, string>,
  )
  const messageId = attrs['message-id']
  const username = attrs['name']
  if (!messageId || !username) {
    return null
  }
  return {
    messageId,
    username,
    threadId: attrs['thread-id'] || undefined,
  }
}

function getDiscordOriginMetadataFromMessage({
  message,
}: {
  message: SessionMessageLike
}): DiscordOriginMetadata | null {
  const syntheticTexts = message.parts.flatMap((part) => {
    if (part.type !== 'text') {
      return [] as string[]
    }
    if (!isSyntheticTextPart(part)) {
      return [] as string[]
    }
    return [part.text || '']
  })

  for (const text of syntheticTexts) {
    const metadata = parseDiscordOriginMetadata(text)
    if (metadata) {
      return metadata
    }
  }

  return null
}

function getRenderableUserTextParts({
  message,
}: {
  message: SessionMessageLike
}): RenderableUserTextPart[] {
  if (message.info.role !== 'user') {
    return []
  }

  return message.parts.flatMap((part) => {
    if (part.type !== 'text') {
      return [] as RenderableUserTextPart[]
    }
    if (isSyntheticTextPart(part)) {
      return [] as RenderableUserTextPart[]
    }
    const cleanedText = extractNonXmlContent(part.text || '').trim()
    if (!cleanedText) {
      return [] as RenderableUserTextPart[]
    }
    return [{ id: part.id, text: cleanedText }]
  })
}

function getExternalUserMirrorText({
  username,
  prompt,
}: {
  username: string
  prompt: string
}): string {
  return `» **${username}:** ${prompt.slice(0, 1000)}${prompt.length > 1000 ? '...' : ''}`
}

function shouldMirrorAssistantPart({
  part,
  verbosity,
}: {
  part: Part
  verbosity: 'tools_and_text' | 'text_and_essential_tools' | 'text_only'
}): boolean {
  if (verbosity === 'text_only') {
    return part.type === 'text'
  }
  if (verbosity === 'text_and_essential_tools') {
    if (part.type === 'text') {
      return true
    }
    return isEssentialToolPart(part)
  }
  return true
}

function getSessionThreadName({
  sessionTitle,
  messages,
}: {
  sessionTitle?: string | null
  messages: SessionMessageLike[]
}): string {
  const normalizedTitle = sessionTitle?.trim()
  if (normalizedTitle) {
    return normalizedTitle.slice(0, 100)
  }
  const firstUserMessage = messages.find((message) => {
    return message.info.role === 'user'
  })
  const firstUserText = firstUserMessage
    ? getRenderableUserTextParts({ message: firstUserMessage })
      .map((part) => {
        return part.text
      })
      .join(' ')
      .trim()
    : ''
  if (firstUserText) {
    return firstUserText.slice(0, 100)
  }
  return 'opencode session'
}

function getSessionRecencyTimestamp(session: ListedSession): number {
  return session.time.updated || session.time.created || 0
}

function sortSessionsByRecency(sessions: ListedSession[]): ListedSession[] {
  return [...sessions].sort((left, right) => {
    return getSessionRecencyTimestamp(right) - getSessionRecencyTimestamp(left)
  })
}

function groupTrackedChannelsByDirectory(
  trackedChannels: TrackedTextChannelRow[],
): DirectorySyncTarget[] {
  const grouped = trackedChannels.reduce((acc, channel) => {
    const existing = acc.get(channel.directory)
    const createdAtMs = Math.max(channel.created_at?.getTime() || 0, CLI_START_MS)
    if (!existing) {
      acc.set(channel.directory, {
        directory: channel.directory,
        channelId: channel.channel_id,
        startMs: createdAtMs,
      })
      return acc
    }
    if (createdAtMs < existing.startMs) {
      acc.set(channel.directory, {
        directory: channel.directory,
        channelId: channel.channel_id,
        startMs: createdAtMs,
      })
    }
    return acc
  }, new Map<string, DirectorySyncTarget>())
  return [...grouped.values()]
}

async function ensureExternalSessionThread({
  discordClient,
  channelId,
  sessionId,
  sessionTitle,
  messages,
}: {
  discordClient: Client
  channelId: string
  sessionId: string
  sessionTitle?: string | null
  messages: SessionMessage[]
}): Promise<ThreadChannel | Error | null> {
  const existingThreadId = await getThreadIdBySessionId(sessionId)
  if (existingThreadId) {
    const existingSource = await getThreadSessionSource(existingThreadId)
    if (existingSource && existingSource !== 'external_poll') {
      logger.log(`[EXTERNAL_SYNC] skipping session ${sessionId}: already managed by ${existingSource} in thread ${existingThreadId}`)
      return null
    }
    const existingThread = await discordClient.channels.fetch(existingThreadId).catch((error) => {
      return new Error(`Failed to fetch thread ${existingThreadId}`, {
        cause: error,
      })
    })
    if (!(existingThread instanceof Error) && existingThread?.isThread()) {
      return existingThread
    }
  }

  const parentChannel = await discordClient.channels.fetch(channelId).catch((error) => {
    return new Error(`Failed to fetch parent channel ${channelId}`, {
      cause: error,
    })
  })
  if (parentChannel instanceof Error) {
    return parentChannel
  }
  if (!parentChannel || parentChannel.type !== ChannelType.GuildText) {
    return new Error(`Channel ${channelId} is not a text channel`)
  }

  const threadName = 'Sync: ' + getSessionThreadName({ sessionTitle, messages })
  const thread = await (parentChannel as TextChannel).threads.create({
    name: threadName.slice(0, 100),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: `Sync external OpenCode session ${sessionId}`,
  }).catch((error) => {
    return new Error(`Failed to create thread for session ${sessionId}`, {
      cause: error,
    })
  })
  if (thread instanceof Error) {
    return thread
  }

  await upsertThreadSession({
    threadId: thread.id,
    sessionId,
    source: 'external_poll',
  })

  return thread
}

type DirectPartMapping = { partId: string; messageId: string; threadId: string }

// Collect all unsynced parts from all messages into SessionChunks.
// User messages that originated from this Discord thread are returned as
// directMappings (persisted without sending a Discord message). All other
// user and assistant parts are returned as chunks to send.
function collectUnsyncedChunks({
  messages,
  syncedPartIds,
  verbosity,
  thread,
}: {
  messages: SessionMessage[]
  syncedPartIds: Set<string>
  verbosity: 'tools_and_text' | 'text_and_essential_tools' | 'text_only'
  thread: ThreadChannel
}): { chunks: SessionChunk[]; directMappings: DirectPartMapping[] } {
  const chunks: SessionChunk[] = []
  const directMappings: DirectPartMapping[] = []

  for (const message of messages) {
    if (message.info.role === 'user') {
      const renderableParts = getRenderableUserTextParts({ message })
      const unsyncedParts = renderableParts.filter((p) => {
        return !syncedPartIds.has(p.id)
      })
      if (unsyncedParts.length === 0) {
        continue
      }
      // If the user message came from this Discord thread, record the
      // mapping to the original Discord message without sending a new one.
      const discordOrigin = getDiscordOriginMetadataFromMessage({ message })
      if (discordOrigin && (!discordOrigin.threadId || discordOrigin.threadId === thread.id)) {
        unsyncedParts.forEach((part) => {
          directMappings.push({
            partId: part.id,
            messageId: discordOrigin.messageId,
            threadId: thread.id,
          })
          syncedPartIds.add(part.id)
        })
        continue
      }
      const promptText = unsyncedParts.map((p) => {
        return p.text
      }).join('\n\n')
      chunks.push({
        partIds: unsyncedParts.map((p) => {
          return p.id
        }),
        content: getExternalUserMirrorText({ username: 'user', prompt: promptText }),
      })
      continue
    }

    if (message.info.role !== 'assistant') {
      continue
    }
    // Filter assistant parts by verbosity before passing to shared collector
    const filteredParts = message.parts.filter((part) => {
      return shouldMirrorAssistantPart({ part, verbosity })
    })
    const { chunks: assistantChunks } = collectSessionChunks({
      messages: [{ info: message.info, parts: filteredParts }],
      skipPartIds: syncedPartIds,
    })
    // Mark empty-content parts as synced (collectSessionChunks skips them)
    for (const part of filteredParts) {
      if (!syncedPartIds.has(part.id)) {
        const content = formatPart(part)
        if (!content.trim()) {
          syncedPartIds.add(part.id)
        }
      }
    }
    chunks.push(...assistantChunks)
  }

  return { chunks, directMappings }
}

async function syncSessionToThread({
  client,
  discordClient,
  directory,
  channelId,
  sessionId,
  sessionTitle,
}: {
  client: OpencodeClient
  discordClient: Client
  directory: string
  channelId: string
  sessionId: string
  sessionTitle?: string | null
}): Promise<void> {
  const messagesResponse = await client.session.messages({
    sessionID: sessionId,
    directory,
  }).catch((error) => {
    return new Error(`Failed to fetch messages for session ${sessionId}`, {
      cause: error,
    })
  })
  if (messagesResponse instanceof Error) {
    throw messagesResponse
  }
  const messages = messagesResponse.data || []

  const thread = await ensureExternalSessionThread({
    discordClient,
    channelId,
    sessionId,
    sessionTitle,
    messages,
  })
  if (thread === null) {
    return
  }
  if (thread instanceof Error) {
    throw thread
  }

  const [existingPartIds, verbosity] = await Promise.all([
    getPartMessageIds(thread.id),
    getChannelVerbosity(thread.parentId || thread.id),
  ])
  const syncedPartIds = new Set(existingPartIds)

  const { chunks, directMappings } = collectUnsyncedChunks({ messages, syncedPartIds, verbosity, thread })

  // Persist mappings for user parts that originated from this Discord thread
  if (directMappings.length > 0) {
    await setPartMessagesBatch(directMappings)
  }

  const batched = batchChunksForDiscord(chunks)
  for (const batch of batched) {
    const sentMessage = await sendThreadMessage(thread, batch.content)
    await setPartMessagesBatch(
      batch.partIds.map((partId) => ({
        partId,
        messageId: sentMessage.id,
        threadId: thread.id,
      })),
    )
  }
}

// Pulse typing indicator in threads whose opencode session is currently busy.
// Called once per directory per poll tick. Uses session.status() which returns
// all session statuses in a single API call.
async function pulseTypingForBusySessions({
  client,
  discordClient,
  directory,
}: {
  client: OpencodeClient
  discordClient: Client
  directory: string
}): Promise<void> {
  const statusResponse = await client.session.status({ directory })
  const statuses = statusResponse.data
  if (!statuses) {
    return
  }
  for (const [sessionId, status] of Object.entries(statuses)) {
    if (status.type !== 'busy') {
      continue
    }
    const threadId = await getThreadIdBySessionId(sessionId)
    if (!threadId) {
      continue
    }
    // Skip sessions already managed by the runtime (source='kimaki')
    const source = await getThreadSessionSource(threadId)
    if (source && source !== 'external_poll') {
      continue
    }
    const thread = await discordClient.channels.fetch(threadId).catch(() => {
      return null
    })
    if (thread?.isThread()) {
      await thread.sendTyping().catch(() => {})
    }
  }
}

async function pollExternalSessions({
  discordClient,
}: {
  discordClient: Client
}): Promise<void> {
  const trackedChannels = await listTrackedTextChannels()
  const directoryTargets = groupTrackedChannelsByDirectory(trackedChannels)
  if (directoryTargets.length === 0) {
    return
  }

  for (const { directory, channelId, startMs } of directoryTargets) {
    if (!fs.existsSync(directory)) {
      continue
    }
    const getClientResult = await initializeOpencodeForDirectory(directory, {
      channelId,
    })
    if (getClientResult instanceof Error) {
      logger.warn(
        `[EXTERNAL_SYNC] Failed to initialize OpenCode for ${directory}: ${getClientResult.message}`,
      )
      continue
    }
    const client = getClientResult()
    const sessionsResponse = await client.session.list({
      directory,
      start: startMs,
      roots: true,
      limit: EXTERNAL_SYNC_MAX_SESSIONS,
    }).catch((error) => {
      return new Error(`Failed to list sessions for ${directory}`, {
        cause: error,
      })
    })
    if (sessionsResponse instanceof Error) {
      logger.warn(`[EXTERNAL_SYNC] ${sessionsResponse.message}`)
      continue
    }

    // Filter by last activity time (time.updated) so old sessions with
    // recent messages are synced, while truly stale sessions are skipped.
    // Also skip sessions whose title hasn't been generated yet (still
    // placeholder "New session - ...") — let the next poll pick them up.
    const sessions = sortSessionsByRecency(
      (sessionsResponse.data || []).filter((s) => {
        if ((s.time.updated || s.time.created || 0) < startMs) {
          return false
        }
        if (/^new session\s*-/i.test(s.title || '')) {
          return false
        }
        return true
      }),
    )
    if (sessions.length > 0) {
      logger.log(`[EXTERNAL_SYNC] ${directory}: ${sessions.length} sessions to sync`)
    }

    for (const session of sessions) {
      await syncSessionToThread({
        client,
        discordClient,
        directory,
        channelId,
        sessionId: session.id,
        sessionTitle: session.title,
      }).catch((error) => {
        logger.warn(
          `[EXTERNAL_SYNC] Failed syncing session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
        void notifyError(
          error instanceof Error ? error : new Error(String(error)),
          `External session sync failed for ${session.id}`,
        )
      })
    }

    // Pulse typing indicator for sessions that are currently busy.
    // Single API call per directory returns all session statuses.
    // Sessions already taken over by ThreadSessionRuntime (source='kimaki')
    // are skipped by ensureExternalSessionThread, so no interference.
    await pulseTypingForBusySessions({ client, discordClient, directory }).catch(() => {})
  }
}

export function startExternalOpencodeSessionSync({
  discordClient,
}: {
  discordClient: Client
}): void {
  if (
    process.env.KIMAKI_VITEST &&
    process.env.KIMAKI_ENABLE_EXTERNAL_OPENCODE_SYNC !== '1'
  ) {
    return
  }
  if (externalSyncInterval) {
    return
  }

  logger.log(`[EXTERNAL_SYNC] started, polling every ${EXTERNAL_SYNC_INTERVAL_MS}ms`)
  let polling = false
  const runPoll = async (): Promise<void> => {
    if (polling) {
      return
    }
    polling = true
    const result = await pollExternalSessions({ discordClient }).catch(
      (e) => new Error('External session poll failed', { cause: e }),
    )
    polling = false
    if (result instanceof Error) {
      logger.warn(`[EXTERNAL_SYNC] ${result.message}`)
      void notifyError(result, 'External session poll top-level failure')
    }
  }

  void runPoll()
  externalSyncInterval = setInterval(() => {
    void runPoll()
  }, EXTERNAL_SYNC_INTERVAL_MS)
}

export function stopExternalOpencodeSessionSync(): void {
  if (!externalSyncInterval) {
    return
  }
  clearInterval(externalSyncInterval)
  externalSyncInterval = null
}

export const externalOpencodeSyncInternals = {
  getRenderableUserTextParts,
  getSessionThreadName,
  groupTrackedChannelsByDirectory,
  sortSessionsByRecency,
  parseDiscordOriginMetadata,
  getDiscordOriginMetadataFromMessage,
}
