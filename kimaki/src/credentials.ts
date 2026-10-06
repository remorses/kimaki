// Discord credentials (spec 3, "Credential resolution"). Two modes:
//
//   self_hosted  the user's own Discord app. Token = bot token, REST = discord.com
//   gateway      the shared Kimaki bot through gateway-proxy. Token =
//                "clientId:clientSecret", REST and WebSocket = the proxy, which
//                only forwards events and guild-scoped routes of the servers
//                this client installed the bot in (docs/gateway-architecture.md)
//
// Priority: KIMAKI_BOT_TOKEN env, saved bot_tokens row (most recently used),
// then the wizard. Rows keep the exact V1 shape so V1 and V2 share them.
//
// Gateway install (V1 flow, website unchanged):
//   generate clientId + secret, save row ─▶ open kimaki.dev/discord-install
//   ─▶ user installs the bot in a server ─▶ website writes gateway_clients
//   ─▶ poll kimaki.dev/api/onboarding/status every 3s ─▶ { guild_id, discord_user_id }

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import * as clack from '@clack/prompts'
import { OAuth2Scopes, PermissionFlagsBits } from 'discord.js'
import dedent from 'string-dedent'

import type { KimakiDb } from './db.ts'
import { ConfigError, DbError } from './errors.ts'
import { createLogger } from './logger.ts'
import * as schema from './schema.ts'

const logger = createLogger('CREDS')
const execFileAsync = promisify(execFile)

// Deploy-time constants of the shared gateway bot; env overrides for staging
// and tests (gatewayUrlsFromEnv()).
export const GATEWAY_APP_ID = process.env['KIMAKI_GATEWAY_APP_ID'] || '1477605701202481173'

export type GatewayUrls = {
  // kimaki.dev: install page and /api/onboarding/status.
  website: string
  // REST base of gateway-proxy (its WebSocket URL with wss -> https).
  proxy: string
}

export function gatewayUrlsFromEnv(): GatewayUrls {
  return {
    website: process.env['KIMAKI_WEBSITE_URL'] || 'https://kimaki.dev',
    proxy: (process.env['KIMAKI_GATEWAY_PROXY_URL'] || 'wss://discord-gateway.kimaki.dev')
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:'),
  }
}

export type BotMode = 'self_hosted' | 'gateway'

export type Credentials = {
  mode: BotMode
  appId: string
  // What discord.js logs in with.
  token: string
  // Gateway mode: gateway-proxy base URL (bot_tokens.proxy_url). null = discord.com.
  baseUrl: string | null
}

// discord.js REST `api` option. The WebSocket URL comes from GET /gateway/bot there.
export function restApiUrl(credentials: Credentials): string | null {
  return credentials.baseUrl ? new URL('/api', credentials.baseUrl).toString() : null
}

// Bot tokens start with base64(application id).
export function appIdFromToken(token: string): string | null {
  const segment = token.split('.')[0] ?? ''
  const decoded = Buffer.from(segment, 'base64').toString('utf8')
  return /^\d{17,20}$/.test(decoded) ? decoded : null
}

export function credentialsFromRow(row: typeof schema.bot_tokens.$inferSelect): Credentials | null {
  if (row.bot_mode === 'self_hosted') {
    return row.token ? { mode: 'self_hosted', appId: row.app_id, token: row.token, baseUrl: null } : null
  }
  const token = row.client_id && row.client_secret ? `${row.client_id}:${row.client_secret}` : row.token
  if (!token.includes(':')) return null
  return { mode: 'gateway', appId: row.app_id, token, baseUrl: row.proxy_url || gatewayUrlsFromEnv().proxy }
}

// KIMAKI_BOT_TOKEN (headless and CI): a bot token, or a gateway clientId:secret pair.
// It wins over saved credentials for the bot start and for CLI subcommands.
export function envCredentials({ urls }: { urls: GatewayUrls }): ConfigError | Credentials | null {
  const token = process.env['KIMAKI_BOT_TOKEN']?.trim()
  if (!token) return null
  if (token.includes(':')) return { mode: 'gateway', appId: GATEWAY_APP_ID, token, baseUrl: urls.proxy }
  const appId = appIdFromToken(token)
  if (!appId) return new ConfigError({ reason: 'KIMAKI_BOT_TOKEN is not a bot token or clientId:secret pair' })
  return { mode: 'self_hosted', appId, token, baseUrl: null }
}

export async function readSavedCredentials({
  db,
  mode,
}: {
  db: KimakiDb
  mode?: BotMode
}): Promise<DbError | Credentials | null> {
  const rows = await db.query.bot_tokens
    .findMany({ ...(mode && { where: { bot_mode: mode } }), orderBy: { last_used_at: 'desc', created_at: 'desc' } })
    .catch((e) => new DbError({ operation: 'read bot_tokens', cause: e }))
  if (rows instanceof Error) return rows
  return rows.map(credentialsFromRow).find((credentials) => credentials !== null) ?? null
}

// Same columns V1 writes for each mode.
export async function saveCredentials({
  db,
  credentials,
}: {
  db: KimakiDb
  credentials: Credentials
}): Promise<DbError | void> {
  const now = new Date()
  const [clientId, clientSecret] = credentials.mode === 'gateway' ? credentials.token.split(':') : []
  const values = {
    token: credentials.token,
    bot_mode: credentials.mode,
    last_used_at: now,
    ...(credentials.mode === 'gateway' && {
      client_id: clientId ?? null,
      client_secret: clientSecret ?? null,
      proxy_url: credentials.baseUrl,
    }),
  }
  const saved = await db
    .insert(schema.bot_tokens)
    .values({ app_id: credentials.appId, ...values })
    .onConflictDoUpdate({ target: schema.bot_tokens.app_id, set: values })
    .catch((e) => new DbError({ operation: 'save bot_tokens', cause: e }))
  if (saved instanceof Error) return saved
}

const BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.AddReactions,
]

export function selfHostedInstallUrl({ appId }: { appId: string }): string {
  const permissions = BOT_PERMISSIONS.reduce((sum, flag) => sum | flag, 0n)
  const params = new URLSearchParams({
    client_id: appId,
    scope: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join(' '),
    permissions: permissions.toString(),
  })
  return `https://discord.com/oauth2/authorize?${params}`
}

// The website starts the Discord OAuth flow and stores the client in
// gateway_clients. callbackUrl: the website redirects there with ?guild_id=.
export function gatewayInstallUrl({
  clientId,
  clientSecret,
  website,
  callbackUrl,
}: {
  clientId: string
  clientSecret: string
  website: string
  callbackUrl?: string
}): string {
  const url = new URL('/discord-install', website)
  url.searchParams.set('clientId', clientId)
  url.searchParams.set('clientSecret', clientSecret)
  if (callbackUrl) url.searchParams.set('kimakiCallbackUrl', callbackUrl)
  return url.toString()
}

export function installUrlFor({
  credentials,
  website,
  callbackUrl,
}: {
  credentials: Credentials
  website: string
  callbackUrl?: string
}): string {
  if (credentials.mode === 'self_hosted') return selfHostedInstallUrl({ appId: credentials.appId })
  const [clientId = '', clientSecret = ''] = credentials.token.split(':')
  return gatewayInstallUrl({ clientId, clientSecret, website, callbackUrl })
}

// Non-TTY hosts (cloud sandboxes, CI) read these on stdout. SSE framing, so
// consumers can use eventsource-parser on noisy output. Public format:
// website/src/docs/docs/guides/programmatic-gateway.mdx.
export type ProgrammaticEvent =
  | { type: 'install_url'; url: string }
  | { type: 'authorized'; guild_id: string }
  | { type: 'ready'; app_id: string; guild_ids: string[] }
  | { type: 'error'; message: string; install_url?: string }

export function emitEvent(event: ProgrammaticEvent): void {
  process.stdout.write(`data: ${JSON.stringify(event)}\n\n`)
}

export type GatewayInstall = { guildId: string; installerId: string | null }

type InstallStatus =
  | { kind: 'installed'; install: GatewayInstall }
  | { kind: 'failed'; reason: string }
  | { kind: 'pending' }
  | { kind: 'unreachable' }

// One status request.
async function checkInstallStatus({
  credentials,
  website,
  timeoutMs = 10_000,
}: {
  credentials: Credentials
  website: string
  timeoutMs?: number
}): Promise<InstallStatus> {
  const [clientId = '', clientSecret = ''] = credentials.token.split(':')
  const url = new URL('/api/onboarding/status', website)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('secret', clientSecret)
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null)
  if (!response) return { kind: 'unreachable' }
  const body = (await response.json().catch(() => null)) as { guild_id?: string; discord_user_id?: string; error?: string; onboarding_error?: boolean } | null
  if (response.ok && body?.guild_id) {
    return { kind: 'installed', install: { guildId: body.guild_id, installerId: body.discord_user_id ?? null } }
  }
  if (response.status === 404 && body?.onboarding_error && body.error) return { kind: 'failed', reason: body.error }
  if (response.status === 404) return { kind: 'pending' }
  return { kind: 'unreachable' }
}

async function pollInstallStatus({
  credentials,
  website,
  onWait,
}: {
  credentials: Credentials
  website: string
  onWait: (elapsedMs: number) => void
}): Promise<ConfigError | GatewayInstall> {
  // First check at once (a resumed install may be done), then every 3s, for 5 minutes in total.
  const started = Date.now()
  const deadline = started + 5 * 60_000
  while (Date.now() < deadline) {
    onWait(Date.now() - started)
    const status = await checkInstallStatus({ credentials, website, timeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now())) })
    if (status.kind === 'installed') return status.install
    if (status.kind === 'failed') return new ConfigError({ reason: `Authorization failed: ${status.reason}. Run kimaki again.` })
    await sleep(Math.min(3_000, Math.max(0, deadline - Date.now())))
  }
  return new ConfigError({ reason: 'Bot authorization timed out after 5 minutes. Run kimaki again.' })
}

// gateway-proxy reloads gateway_clients every 1s (db_config.rs) and rejects
// unknown clients. Waits until it accepts this one, instead of a fixed sleep.
async function waitForProxyClient({ credentials, proxy }: { credentials: Credentials; proxy: string }): Promise<ConfigError | void> {
  const url = new URL('/api/v10/gateway/bot', proxy)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const timeout = Math.max(1, Math.min(10_000, deadline - Date.now()))
    const response = await fetch(url, { headers: { authorization: `Bot ${credentials.token}` }, signal: AbortSignal.timeout(timeout) }).catch(() => null)
    if (response?.ok) return
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())))
  }
  return new ConfigError({ reason: `gateway-proxy ${proxy} did not accept the new client within 30s. Run kimaki again.` })
}

async function openInBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  await execFileAsync(command, [url]).catch(() => undefined)
}

// Gateway credentials are saved before the install finishes, so an install
// URL stays valid across restarts. Reuses them, else creates new ones.
export async function gatewayCredentials({ db, urls }: { db: KimakiDb; urls: GatewayUrls }): Promise<DbError | Credentials> {
  const saved = await readSavedCredentials({ db, mode: 'gateway' })
  if (saved instanceof Error) return saved
  const credentials: Credentials = saved ?? {
    mode: 'gateway',
    appId: GATEWAY_APP_ID,
    token: `${crypto.randomUUID()}:${crypto.randomBytes(32).toString('hex')}`,
    baseUrl: urls.proxy,
  }
  const stored = await saveCredentials({ db, credentials })
  if (stored instanceof Error) return stored
  return credentials
}

export async function installGateway({
  db,
  urls,
  callbackUrl,
}: {
  db: KimakiDb
  urls: GatewayUrls
  callbackUrl?: string
}): Promise<ConfigError | DbError | ResolvedCredentials> {
  const credentials = await gatewayCredentials({ db, urls })
  if (credentials instanceof Error) return credentials
  const url = installUrlFor({ credentials, website: urls.website, callbackUrl })

  const interactive = Boolean(process.stdin.isTTY)
  if (!interactive) emitEvent({ type: 'install_url', url })
  if (interactive) {
    clack.note(
      `${url}\n\nDo not share this URL: it contains your credentials.\nNo server yet? Create one first (+ in the Discord sidebar).`,
      'Install the Kimaki bot in your Discord server',
    )
    await openInBrowser(url)
  }
  const spinner = interactive ? clack.spinner() : null
  spinner?.start('Waiting for the bot to be installed in a server...')
  const install = await pollInstallStatus({
    credentials,
    website: urls.website,
    onWait: (elapsedMs) => {
      if (elapsedMs >= 135_000) spinner?.message('Still waiting... No servers listed? Create one first, then reopen the URL above')
      else if (elapsedMs >= 45_000) spinner?.message('Still waiting... Select a server on the Discord page and click "Authorize"')
    },
  })
  spinner?.stop(install instanceof Error ? install.message : 'Bot installed')
  if (install instanceof Error) {
    if (!interactive) emitEvent({ type: 'error', message: install.message, install_url: url })
    return install
  }
  if (!interactive) emitEvent({ type: 'authorized', guild_id: install.guildId })
  const accepted = await waitForProxyClient({ credentials, proxy: credentials.baseUrl ?? urls.proxy })
  if (accepted instanceof Error) return accepted
  logger.log(`gateway client installed in guild ${install.guildId}`)
  return { credentials, install }
}

async function promptSelfHostedToken(): Promise<ConfigError | Credentials> {
  clack.note(
    dedent`
      1. Create an app: https://discord.com/developers/applications
      2. Bot tab: enable Message Content Intent
      3. Bot tab: Reset Token, then paste it here
    `,
    'Discord bot',
  )
  const token = await clack.password({
    message: 'Bot token',
    validate: (value) => (value && appIdFromToken(value.trim()) ? undefined : 'This does not look like a bot token'),
  })
  if (clack.isCancel(token)) return new ConfigError({ reason: 'Onboarding cancelled' })
  const trimmed = token.trim()
  return { mode: 'self_hosted', appId: appIdFromToken(trimmed) ?? '', token: trimmed, baseUrl: null }
}

export type ResolvedCredentials = { credentials: Credentials; install: GatewayInstall | null }

export async function resolveCredentials({
  db,
  gateway,
  restartOnboarding,
  urls,
  callbackUrl,
}: {
  db: KimakiDb
  // --gateway: use saved gateway credentials, or install the gateway bot.
  gateway: boolean
  restartOnboarding: boolean
  urls: GatewayUrls
  // --gateway-callback-url
  callbackUrl?: string
}): Promise<ConfigError | DbError | ResolvedCredentials> {
  const fromEnv = envCredentials({ urls })
  if (fromEnv instanceof Error) return fromEnv
  if (fromEnv && !gateway && !restartOnboarding) {
    const saved = await saveCredentials({ db, credentials: fromEnv })
    if (saved instanceof Error) return saved
    return { credentials: fromEnv, install: null }
  }

  if (!restartOnboarding) {
    const saved = await readSavedCredentials({ db, mode: gateway ? 'gateway' : undefined })
    if (saved instanceof Error) return saved
    // Unfinished gateway installs are unknown to the proxy (login fails):
    // continue that install. Only a definite "not installed" answer counts,
    // so a kimaki.dev outage does not block saved credentials.
    const status = saved?.mode === 'gateway' ? await checkInstallStatus({ credentials: saved, website: urls.website }) : null
    const unfinished = status?.kind === 'pending' || status?.kind === 'failed'
    if (saved && !unfinished) {
      // Mark as most recently used, so `project add` picks the same bot.
      const touched = await saveCredentials({ db, credentials: saved })
      if (touched instanceof Error) return touched
      return { credentials: saved, install: null }
    }
    if (saved) {
      logger.log('saved gateway client was never installed, resuming the install')
      return installGateway({ db, urls, callbackUrl })
    }
  }

  const mode = await (async (): Promise<ConfigError | BotMode> => {
    if (gateway || !process.stdin.isTTY) return 'gateway'
    const choice = await clack.select({
      message: 'How do you want to connect to Discord?',
      options: [
        { value: 'gateway' as const, label: 'Gateway', hint: 'the shared Kimaki bot, no setup' },
        { value: 'self_hosted' as const, label: 'Self-hosted', hint: 'your own Discord app, 5-10 min setup' },
      ],
    })
    if (clack.isCancel(choice)) return new ConfigError({ reason: 'Onboarding cancelled' })
    return choice
  })()
  if (mode instanceof Error) return mode
  if (mode === 'gateway') return installGateway({ db, urls, callbackUrl })

  const credentials = await promptSelfHostedToken()
  if (credentials instanceof Error) return credentials
  const saved = await saveCredentials({ db, credentials })
  if (saved instanceof Error) return saved
  process.stderr.write(`\nAdd the bot to your server: ${selfHostedInstallUrl({ appId: credentials.appId })}\n\n`)
  return { credentials, install: null }
}
