import { ChannelType, Routes, type REST } from 'discord.js'
import * as errore from 'errore'
import { DiscordApiError } from './errors.js'
import { isThreadChannelType } from './discord-utils.js'
import { isJsonRecord, jsonString } from './utils.js'

export const DISCORD_THREAD_LIST_PAGE_SIZE = 100
const ARCHIVED_THREAD_FETCH_LIMIT = 200

export type DiscordThreadArchiveState = 'active' | 'archived'

export type DiscordChannelThread = {
  id: string
  name: string
  parentId: string
  guildId: string
  archived: boolean
  archiveState: DiscordThreadArchiveState
  lastMessageId: string | null
}

class DiscordThreadListError extends errore.createTaggedError({
  name: 'DiscordThreadListError',
  message: 'Failed to list Discord threads for channel $channelId',
}) {}

export function parseDiscordThreadPayload({
  payload,
  parentId,
  guildId,
}: {
  payload: unknown
  parentId: string
  guildId: string
}): DiscordChannelThread | null {
  if (!isJsonRecord(payload)) return null
  const id = jsonString(payload.id)
  const type = typeof payload.type === 'number' ? payload.type : -1
  if (!id || !isThreadChannelType(type)) {
    return null
  }
  const payloadParentId = jsonString(payload.parent_id)
  if (payloadParentId && payloadParentId !== parentId) {
    return null
  }
  const metadata = isJsonRecord(payload.thread_metadata) ? payload.thread_metadata : undefined
  const archived = metadata?.archived === true
  return {
    id,
    name: jsonString(payload.name) || id,
    parentId,
    guildId: jsonString(payload.guild_id) || guildId,
    archived,
    archiveState: archived ? 'archived' : 'active',
    lastMessageId: jsonString(payload.last_message_id) ?? null,
  }
}

export function mergeDiscordChannelThreads({
  threads,
}: {
  threads: DiscordChannelThread[]
}): DiscordChannelThread[] {
  const byId = new Map<string, DiscordChannelThread>()
  for (const thread of threads) {
    byId.set(thread.id, thread)
  }
  return [...byId.values()].sort((left, right) => {
    if (left.archived !== right.archived) {
      return left.archived ? 1 : -1
    }
    const leftMessage = left.lastMessageId ?? ''
    const rightMessage = right.lastMessageId ?? ''
    if (leftMessage !== rightMessage) {
      return rightMessage.localeCompare(leftMessage)
    }
    return left.name.localeCompare(right.name)
  })
}

function parseThreadListPayload({
  payload,
  parentId,
  guildId,
}: {
  payload: unknown
  parentId: string
  guildId: string
}): { threads: DiscordChannelThread[]; hasMore: boolean } {
  if (!isJsonRecord(payload)) {
    return { threads: [], hasMore: false }
  }
  const rawThreads = Array.isArray(payload.threads) ? payload.threads : []
  const threads = rawThreads.flatMap((thread) => {
    const parsed = parseDiscordThreadPayload({
      payload: thread,
      parentId,
      guildId,
    })
    return parsed ? [parsed] : []
  })
  return {
    threads,
    hasMore: payload.has_more === true,
  }
}

async function fetchDiscordJson({
  rest,
  route,
  query,
}: {
  rest: REST
  route: `/${string}`
  query?: URLSearchParams
}): Promise<unknown | DiscordApiError> {
  const result = await rest
    .get(route, query ? { query } : undefined)
    .catch((cause) => {
      return new DiscordApiError({
        status: String(Reflect.get(cause, 'status') ?? 'unknown'),
        body: cause instanceof Error ? cause.message : String(cause),
        cause,
      })
    })
  return result
}

async function listArchivedPublicThreads({
  rest,
  channelId,
  guildId,
}: {
  rest: REST
  channelId: string
  guildId: string
}): Promise<DiscordChannelThread[] | DiscordApiError> {
  const threads: DiscordChannelThread[] = []
  let before: string | undefined
  while (threads.length < ARCHIVED_THREAD_FETCH_LIMIT) {
    const query = new URLSearchParams({
      limit: String(DISCORD_THREAD_LIST_PAGE_SIZE),
    })
    if (before) {
      query.set('before', before)
    }
    const payload = await fetchDiscordJson({
      rest,
      route: Routes.channelThreads(channelId, 'public'),
      query,
    })
    if (payload instanceof DiscordApiError) {
      return payload
    }
    const page = parseThreadListPayload({
      payload,
      parentId: channelId,
      guildId,
    })
    threads.push(...page.threads)
    const lastThread = page.threads.at(-1)
    if (!page.hasMore || !lastThread) {
      break
    }
    before = lastThread.id
  }
  return threads
}

export async function listDiscordChannelThreads({
  rest,
  channelId,
}: {
  rest: REST
  channelId: string
}): Promise<
  | { ok: true; threads: DiscordChannelThread[] }
  | { ok: false; error: DiscordThreadListError | DiscordApiError }
> {
  const channelPayload = await fetchDiscordJson({
    rest,
    route: Routes.channel(channelId),
  })
  if (channelPayload instanceof DiscordApiError) {
    return { ok: false, error: channelPayload }
  }
  const channel = (channelPayload ?? {}) as {
    id?: string
    type?: number
    guild_id?: string
    parent_id?: string
  }
  if (channel.type !== ChannelType.GuildText) {
    return {
      ok: false,
      error: new DiscordThreadListError({
        channelId,
        cause: new Error('Channel is not a guild text channel'),
      }),
    }
  }
  const guildId = channel.guild_id
  if (!guildId) {
    return {
      ok: false,
      error: new DiscordThreadListError({
        channelId,
        cause: new Error('Channel has no guild ID'),
      }),
    }
  }

  const activePayload = await fetchDiscordJson({
    rest,
    route: Routes.guildActiveThreads(guildId),
  })
  if (activePayload instanceof DiscordApiError) {
    return { ok: false, error: activePayload }
  }
  const activeThreads = parseThreadListPayload({
    payload: activePayload,
    parentId: channelId,
    guildId,
  }).threads

  const archivedThreads = await listArchivedPublicThreads({
    rest,
    channelId,
    guildId,
  })
  if (archivedThreads instanceof DiscordApiError) {
    return { ok: false, error: archivedThreads }
  }

  return {
    ok: true,
    threads: mergeDiscordChannelThreads({
      threads: [...activeThreads, ...archivedThreads],
    }),
  }
}
