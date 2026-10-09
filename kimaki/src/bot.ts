// The one context every bot function takes as its first parameter. main.ts
// builds it once per bot; tests start several bots in one process, so per-bot
// state never lives in module globals. State owned by one feature stays in
// that feature's closure; Bot only exposes its operations (`features`).
//
// Also the small helpers most writers share: OpenCode calls with errore
// wrapping, project and thread lookups, the session marker.

import type { JsonValue, SessionMetadata } from '@opencode/client'
import { ChannelType, type Client, type TextChannel, type ThreadChannel } from 'discord.js'

import type { AgentUi } from './agent-ui.ts'
import type { Analytics } from './analytics.ts'
import type { KimakiDb } from './db.ts'
import type { EffectsRunner } from './effects.ts'
import { ConfigError, DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError } from './errors.ts'
import type { EventLoop } from './event-loop.ts'
import type { OpenCodeClient, OpencodeConnection } from './opencode-server.ts'
import type { Route } from './routes.ts'
import type { Clock } from './scheduler.ts'
import type { PluginWait } from './sessions.ts'
import type { SleepLock } from './sleeps.ts'
import type { BotStore } from './store.ts'
import type { ScheduledRun } from './system-prompt.ts'
import type { TranscriptionBaseUrls } from './voice.ts'

export type Author = { id: string; username: string }

export type PromptFile = { uri: string; name: string }

export type ModelChoice = { providerID: string; id: string; variant: string | null }

// Operations of feature-owned state that non-interaction code needs. Wizard
// and form state is only reachable from the slash registry (slash-commands.ts).
export type BotFeatures = {
  withSleepLock: SleepLock
  waitForPlugin: PluginWait
  agentUi: AgentUi
}

export type Bot = {
  discord: Client
  db: KimakiDb
  store: BotStore
  opencode: OpencodeConnection
  eventLoop: EventLoop
  effects: EffectsRunner
  analytics: Analytics
  // The scheduler's only source of "now"; tests pass a manual clock.
  clock: Clock
  dataDir: string
  // Port of this bot's lock server; written into session markers for the agent's `kimaki` calls.
  lockPort: number
  // Started by the `kimaki` supervisor: `kimaki restart` can respawn it.
  supervised: boolean
  // Discord bot token: selects the bot_tokens row with the audio API keys.
  token: string
  // bot_tokens.app_id of these credentials: key of the global_models row.
  appId: string
  transcriptionBaseUrls: TranscriptionBaseUrls
  // Default for channels without a channel_worktrees row.
  autoWorktrees: boolean
  features: BotFeatures
}

// One OpenCode call of the current connection, with its rejection as an OpenCodeError.
export async function oc<T>(
  bot: Pick<Bot, 'opencode'>,
  operation: string,
  run: (client: OpenCodeClient) => Promise<T>,
): Promise<OpenCodeUnavailableError | OpenCodeError | T> {
  const client = bot.opencode.endpoint?.client
  if (!client) return new OpenCodeUnavailableError({ reason: 'not connected' })
  return run(client).catch((cause) => new OpenCodeError({ operation, cause }))
}

// The project row of a channel; null when the channel is not a project here.
export async function projectOf(bot: Bot, channelId: string) {
  const row = await bot.db.query.channel_directories
    .findFirst({ where: { channel_id: channelId } })
    .catch((cause) => new DbError({ operation: 'read channel_directories', cause }))
  if (row instanceof Error) return row
  return row ?? null
}

// Current working directory of a session (session.moved changes it).
export async function sessionDirectory(bot: Pick<Bot, 'opencode'>, sessionId: string) {
  const info = await oc(bot, 'read session directory', (client) => client.session.get({ sessionID: sessionId }))
  if (info instanceof Error) return info
  return info.location.directory
}

export function rootSession(bot: Bot, threadId: string): OpenCodeError | string {
  return bot.store.getState().roots[threadId] ?? new OpenCodeError({ operation: `find the session of thread ${threadId}` })
}

// The thread whose root session this is; null for children and unknown sessions.
export function threadOfSession(bot: Bot, sessionId: string): string | null {
  const { sessionThreads, roots } = bot.store.getState()
  const threadId = sessionThreads[sessionId]
  return threadId && roots[threadId] === sessionId ? threadId : null
}

export async function fetchThread(bot: Bot, threadId: string): Promise<DiscordError | ConfigError | ThreadChannel> {
  const channel = await bot.discord.channels
    .fetch(threadId)
    .catch((cause) => new DiscordError({ operation: `fetch thread ${threadId}`, cause }))
  if (channel instanceof Error) return channel
  if (!channel?.isThread()) return new ConfigError({ reason: 'Target is not a thread' })
  return channel
}

export async function textChannel(bot: Bot, channelId: string): Promise<DiscordError | TextChannel> {
  const channel = await bot.discord.channels
    .fetch(channelId)
    .catch((cause) => new DiscordError({ operation: `fetch channel ${channelId}`, cause }))
  if (channel instanceof Error) return channel
  if (channel?.type !== ChannelType.GuildText) return new DiscordError({ operation: `use non-text channel ${channelId}` })
  return channel
}

// metadata.kimaki of a session: what the plugin and the agent's `kimaki` calls read.
export type SessionMarker = {
  // Every stored field; kept when the bot rewrites the marker.
  fields: { readonly [key: string]: JsonValue }
  dataDir: string | null
  lockPort: number | null
  // Explicit `kimaki send --parent-session`, so /resume keeps the instruction line.
  parentSessionId: string | null
  // The scheduled run stored at session.create, so /resume keeps the same instruction section.
  task: ScheduledRun | null
}

function jsonObject(value: JsonValue | undefined): { readonly [key: string]: JsonValue } | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

export function readMarker(metadata: SessionMetadata | undefined): SessionMarker | null {
  const fields = jsonObject(metadata?.['kimaki'])
  if (!fields) return null
  const { dataDir, lockPort, parentSessionId } = fields
  const task = jsonObject(fields['task'])
  const taskId = task?.['id']
  const cronExpr = task?.['cronExpr']
  const timezone = task?.['timezone']
  return {
    fields,
    dataDir: typeof dataDir === 'string' ? dataDir : null,
    lockPort: typeof lockPort === 'number' ? lockPort : null,
    parentSessionId: typeof parentSessionId === 'string' ? parentSessionId : null,
    task: typeof taskId === 'number'
      ? { id: taskId, cronExpr: typeof cronExpr === 'string' ? cronExpr : null, timezone: typeof timezone === 'string' ? timezone : null }
      : null,
  }
}

// The marker fields that point the agent's `kimaki` calls at this bot.
export function cliContext(bot: Bot) {
  return { dataDir: bot.dataDir, lockPort: bot.lockPort }
}

// Default model of new sessions in channels without their own (/model "All channels").
export async function globalModel(bot: Bot): Promise<DbError | ModelChoice | null> {
  const row = await bot.db.query.global_models
    .findFirst({ where: { app_id: bot.appId } })
    .catch((cause) => new DbError({ operation: 'read global_models', cause }))
  if (row instanceof Error) return row
  const model = parseModel(row?.model_id, row?.variant)
  return model ? { ...model, variant: row?.variant ?? null } : null
}

export function parseModel(value: string | null | undefined, variant: string | null | undefined) {
  if (!value) return null
  const slash = value.indexOf('/')
  if (slash <= 0) return null
  return {
    providerID: value.slice(0, slash),
    id: value.slice(slash + 1),
    ...(variant && { variant }),
  }
}

// What a thread name and an echo show for an input.
export function routeText(route: Route): string {
  if (route.kind === 'shell') return `!${route.command}`
  if (route.kind === 'command') return `/${route.name}${route.arguments ? ` ${route.arguments}` : ''}`
  if (route.kind === 'skill') return `/${route.id}${route.arguments ? ` ${route.arguments}` : ''}`
  return route.text
}
