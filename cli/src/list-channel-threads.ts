import { ChannelType, Routes, type REST } from 'discord.js'
import * as errore from 'errore'
import { DiscordApiError } from './errors.js'
import { isThreadChannelType } from './discord-utils.js'

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

type DiscordThreadPayload = {
  id?: string
  name?: string
  type?: number
  parent_id?: string
  guild_id?: string
  last_message_id?: string | null
  thread_metadata?: {
    archived?: boolean
  }
}

type DiscordThreadListPayload = {
  threads?: DiscordThreadPayload[]
  has_more?: boolean
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
  payload: DiscordThreadPayload
  parentId: string
  guildId: string
}): DiscordChannelThread | null {
  if (!payload.id || !isThreadChannelType(payload.type ?? -1)) {
    return null
  }
  if (payload.parent_id && payload.parent_id !== parentId) {
    return null
  }
  const archived = Boolean(payload.thread_metadata?.archived)
  return {
    id: payload.id,
    name: payload.name || payload.id,
    parentId,
    guildId: payload.guild_id || guildId,
    archived,
    archiveState: archived ? 'archived' : 'active',
    lastMessageId: payload.last_message_id ?? null,
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
  if (!payload || typeof payload !== 'object') {
    return { threads: [], hasMore: false }
  }
  const list = payload as DiscordThreadListPayload
  const threads = (list.threads ?? []).flatMap((thread) => {
    const parsed = parseDiscordThreadPayload({
      payload: thread,
      parentId,
      guildId,
    })
    return parsed ? [parsed] : []
  })
  return {
    threads,
    hasMore: Boolean(list.has_more),
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
