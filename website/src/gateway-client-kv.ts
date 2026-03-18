// KV helpers for gateway client auth, Slack install state, and team routing cache.

import { createPrisma } from 'db/src'
import type { HonoBindings } from './env.js'

export type GatewayClientCacheRecord = {
  client_id: string
  secret: string
  guild_id: string
  platform: GatewayClientPlatform
  bot_token: string | null
  user_id: string | null
  created_at: string
  updated_at: string | null
}

export type GatewayClientPlatform = 'discord' | 'slack'

export type SlackInstallStateRecord = {
  kimaki_client_id: string
  kimaki_client_secret: string
  kimaki_callback_url: string | null
}

const GATEWAY_CLIENT_KV_TTL_SECONDS = 60
const TEAM_CLIENT_IDS_KV_TTL_SECONDS = 30
const SLACK_INSTALL_STATE_KV_TTL_SECONDS = 600

function gatewayClientKvKey({ clientId }: { clientId: string }): string {
  return `gateway-client:v1:${clientId}`
}

function teamClientIdsKvKey({ teamId }: { teamId: string }): string {
  return `team-client-ids:v1:${teamId}`
}

function slackInstallStateKvKey({ state }: { state: string }): string {
  return `slack-install-state:v1:${state}`
}

export async function getGatewayClientFromKv({
  clientId,
  kv,
}: {
  clientId: string
  kv: KVNamespace
}): Promise<GatewayClientCacheRecord | undefined> {
  const payload = await kv.get(gatewayClientKvKey({ clientId }), 'json')
  if (!isGatewayClientCacheRecord(payload)) {
    return undefined
  }
  return payload
}

export async function setGatewayClientInKv({
  kv,
  row,
}: {
  kv: KVNamespace
  row: GatewayClientCacheRecord
}): Promise<void> {
  await kv.put(gatewayClientKvKey({ clientId: row.client_id }), JSON.stringify(row), {
    expirationTtl: GATEWAY_CLIENT_KV_TTL_SECONDS,
  })
}

export async function getTeamClientIdsFromKv({
  teamId,
  kv,
}: {
  teamId: string
  kv: KVNamespace
}): Promise<string[] | undefined> {
  const payload = await kv.get(teamClientIdsKvKey({ teamId }), 'json')
  if (!(payload && typeof payload === 'object' && 'clientIds' in payload)) {
    return undefined
  }
  const candidate = payload.clientIds
  if (!Array.isArray(candidate)) {
    return undefined
  }
  const clientIds = candidate.filter((clientId) => {
    return typeof clientId === 'string'
  })
  return clientIds
}

export async function setTeamClientIdsInKv({
  kv,
  teamId,
  clientIds,
}: {
  kv: KVNamespace
  teamId: string
  clientIds: string[]
}): Promise<void> {
  await kv.put(teamClientIdsKvKey({ teamId }), JSON.stringify({ clientIds }), {
    expirationTtl: TEAM_CLIENT_IDS_KV_TTL_SECONDS,
  })
}

export async function getSlackInstallStateFromKv({
  kv,
  state,
}: {
  kv: KVNamespace
  state: string
}): Promise<SlackInstallStateRecord | undefined> {
  const payload = await kv.get(slackInstallStateKvKey({ state }), 'json')
  if (!isSlackInstallStateRecord(payload)) {
    return undefined
  }
  return payload
}

export async function setSlackInstallStateInKv({
  kv,
  state,
  record,
}: {
  kv: KVNamespace
  state: string
  record: SlackInstallStateRecord
}): Promise<void> {
  await kv.put(slackInstallStateKvKey({ state }), JSON.stringify(record), {
    expirationTtl: SLACK_INSTALL_STATE_KV_TTL_SECONDS,
  })
}

export async function deleteSlackInstallStateInKv({
  kv,
  state,
}: {
  kv: KVNamespace
  state: string
}): Promise<void> {
  await kv.delete(slackInstallStateKvKey({ state }))
}

export async function invalidateTeamClientIdsInKv({
  kv,
  teamId,
}: {
  kv: KVNamespace
  teamId: string
}): Promise<void> {
  await kv.delete(teamClientIdsKvKey({ teamId }))
}

export async function upsertGatewayClientAndRefreshKv({
  env,
  clientId,
  secret,
  guildId,
  platform,
  botToken,
  userId,
  reachableUrl,
}: {
  env: HonoBindings
  clientId: string
  secret: string
  guildId: string
  platform: GatewayClientPlatform
  botToken?: string | null
  userId?: string | null
  /** When set, the gateway-proxy connects outbound to this URL's /gateway WS
   *  endpoint instead of waiting for the client to connect inbound. */
  reachableUrl?: string | null
}): Promise<GatewayClientCacheRecord | Error> {
  const prisma = createPrisma(env.HYPERDRIVE.connectionString)
  const upsertedGatewayClient = await prisma.gateway_clients
    .upsert({
      where: {
        client_id_guild_id: {
          client_id: clientId,
          guild_id: guildId,
        },
      },
      create: {
        client_id: clientId,
        secret,
        guild_id: guildId,
        platform,
        bot_token: botToken ?? null,
        user_id: userId ?? undefined,
        reachable_url: reachableUrl ?? null,
      },
      update: {
        secret,
        platform,
        bot_token: botToken ?? null,
        user_id: userId ?? undefined,
        reachable_url: reachableUrl ?? null,
      },
    })
    .catch((cause) => {
      return new Error('Failed to upsert gateway_clients', { cause })
    })
  if (upsertedGatewayClient instanceof Error) {
    return upsertedGatewayClient
  }

  const normalizedGatewayClient = normalizeGatewayClientRow({
    row: upsertedGatewayClient,
  })

  await setGatewayClientInKv({
    kv: env.GATEWAY_CLIENT_KV,
    row: normalizedGatewayClient,
  }).catch((cause) => {
    console.warn('Failed to write gateway client KV cache', cause)
  })

  await invalidateTeamClientIdsInKv({
    kv: env.GATEWAY_CLIENT_KV,
    teamId: guildId,
  }).catch((cause) => {
    console.warn('Failed to invalidate team client KV cache', cause)
  })

  return normalizedGatewayClient
}

export async function resolveGatewayClientFromCacheOrDb({
  clientId,
  env,
}: {
  clientId: string
  env: HonoBindings
}): Promise<GatewayClientCacheRecord | Error | undefined> {
  const cached = await getGatewayClientFromKv({
    clientId,
    kv: env.GATEWAY_CLIENT_KV,
  }).catch((cause) => {
    return new Error('KV read failed for gateway client', { cause })
  })
  if (cached instanceof Error) {
    return cached
  }
  if (cached) {
    return cached
  }

  const prisma = createPrisma(env.HYPERDRIVE.connectionString)
  const row = await prisma.gateway_clients.findFirst({
    where: { client_id: clientId },
    orderBy: [{ updated_at: 'desc' }, { created_at: 'desc' }],
    select: {
      client_id: true,
      secret: true,
      guild_id: true,
      platform: true,
      bot_token: true,
      user_id: true,
      created_at: true,
      updated_at: true,
    },
  }).catch((cause) => {
    return new Error('DB lookup failed for gateway client', { cause })
  })
  if (row instanceof Error) {
    return row
  }
  if (!row) {
    return undefined
  }

  const normalized = normalizeGatewayClientRow({ row })
  await setGatewayClientInKv({
    kv: env.GATEWAY_CLIENT_KV,
    row: normalized,
  }).catch(() => {
    return undefined
  })
  return normalized
}

export function normalizeGatewayClientRow({
  row,
}: {
  row: {
    client_id: string
    secret: string
    guild_id: string
    platform: GatewayClientPlatform
    bot_token: string | null
    user_id: string | null
    created_at: Date
    updated_at: Date | null
  }
}): GatewayClientCacheRecord {
  return {
    client_id: row.client_id,
    secret: row.secret,
    guild_id: row.guild_id,
    platform: row.platform,
    bot_token: row.bot_token,
    user_id: row.user_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at?.toISOString() ?? null,
  }
}

function isGatewayClientCacheRecord(
  value: unknown,
): value is GatewayClientCacheRecord {
  if (!isRecord(value)) {
    return false
  }

  const record = value
  return (
    typeof record.client_id === 'string'
    && typeof record.secret === 'string'
    && typeof record.guild_id === 'string'
    && (record.platform === 'discord' || record.platform === 'slack')
    && (typeof record.bot_token === 'string' || record.bot_token === null)
    && (typeof record.user_id === 'string' || record.user_id === null)
    && typeof record.created_at === 'string'
    && (typeof record.updated_at === 'string' || record.updated_at === null)
  )
}

function isSlackInstallStateRecord(
  value: unknown,
): value is SlackInstallStateRecord {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.kimaki_client_id === 'string'
    && typeof value.kimaki_client_secret === 'string'
    && (typeof value.kimaki_callback_url === 'string' || value.kimaki_callback_url === null)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
