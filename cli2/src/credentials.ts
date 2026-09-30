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

// Deploy-time constants of the shared gateway bot; env overrides for staging.
export const GATEWAY_APP_ID = process.env['KIMAKI_GATEWAY_APP_ID'] || '1477605701202481173'
export const WEBSITE_URL = process.env['KIMAKI_WEBSITE_URL'] || 'https://kimaki.dev'
// REST base of gateway-proxy (its WebSocket URL with wss -> https).
export const GATEWAY_PROXY_URL = (process.env['KIMAKI_GATEWAY_PROXY_URL'] || 'wss://discord-gateway.kimaki.dev')
  .replace(/^wss:/, 'https:')
  .replace(/^ws:/, 'http:')

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
  return { mode: 'gateway', appId: row.app_id, token, baseUrl: row.proxy_url || GATEWAY_PROXY_URL }
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

// The website starts the Discord OAuth flow and stores the client in gateway_clients.
export function gatewayInstallUrl({ clientId, clientSecret }: { clientId: string; clientSecret: string }): string {
  const url = new URL('/discord-install', WEBSITE_URL)
  url.searchParams.set('clientId', clientId)
  url.searchParams.set('clientSecret', clientSecret)
  return url.toString()
}

export type GatewayInstall = { guildId: string; installerId: string | null }

// One status request. null = not installed yet (or website unreachable).
async function checkInstallStatus({
  clientId,
  clientSecret,
}: {
  clientId: string
  clientSecret: string
}): Promise<ConfigError | GatewayInstall | null> {
  const url = new URL('/api/onboarding/status', WEBSITE_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('secret', clientSecret)
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null)
  if (!response) return null
  const body = (await response.json().catch(() => null)) as { guild_id?: string; discord_user_id?: string; error?: string; onboarding_error?: boolean } | null
  if (response.ok && body?.guild_id) return { guildId: body.guild_id, installerId: body.discord_user_id ?? null }
  if (response.status === 404 && body?.onboarding_error && body.error) {
    return new ConfigError({ reason: `Authorization failed: ${body.error}` })
  }
  return null
}

async function pollInstallStatus({
  clientId,
  clientSecret,
}: {
  clientId: string
  clientSecret: string
}): Promise<ConfigError | GatewayInstall> {
  // 100 x 3s = 5 minutes, like V1.
  for (let attempt = 0; attempt < 100; attempt++) {
    await sleep(3_000)
    const status = await checkInstallStatus({ clientId, clientSecret })
    if (status) return status
  }
  return new ConfigError({ reason: 'Bot authorization timed out after 5 minutes. Run kimaki again.' })
}

async function openInBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  await execFileAsync(command, [url]).catch(() => undefined)
}

// Headless hosts (non-TTY) read one JSON event per line on stdout, like V1.
function emitJsonEvent(event: Record<string, string>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

// Only a definite "not installed" answer counts: when kimaki.dev is down,
// saved credentials are tried as before.
async function isGatewayInstalled(credentials: Credentials): Promise<boolean> {
  const [clientId = '', clientSecret = ''] = credentials.token.split(':')
  const url = new URL('/api/onboarding/status', WEBSITE_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('secret', clientSecret)
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null)
  if (!response) return true
  if (response.status !== 404) return true
  logger.log('saved gateway client was never installed, resuming the install')
  return false
}

export async function installGateway({ db }: { db: KimakiDb }): Promise<ConfigError | DbError | {
  credentials: Credentials
  install: GatewayInstall
}> {
  // Reuse an unfinished install's client, so an old install URL stays valid.
  const saved = await readSavedCredentials({ db, mode: 'gateway' })
  if (saved instanceof Error) return saved
  const credentials: Credentials = saved ?? {
    mode: 'gateway',
    appId: GATEWAY_APP_ID,
    token: `${crypto.randomUUID()}:${crypto.randomBytes(32).toString('hex')}`,
    baseUrl: GATEWAY_PROXY_URL,
  }
  const stored = await saveCredentials({ db, credentials })
  if (stored instanceof Error) return stored
  const [clientId = '', clientSecret = ''] = credentials.token.split(':')
  const url = gatewayInstallUrl({ clientId, clientSecret })

  const interactive = Boolean(process.stdin.isTTY)
  if (!interactive) emitJsonEvent({ type: 'install_url', url })
  if (interactive) {
    clack.note(
      `${url}\n\nDo not share this URL: it contains your credentials.\nNo server yet? Create one first (+ in the Discord sidebar).`,
      'Install the Kimaki bot in your Discord server',
    )
    await openInBrowser(url)
  }
  const spinner = interactive ? clack.spinner() : null
  spinner?.start('Waiting for the bot to be installed in a server...')
  const install = await pollInstallStatus({ clientId, clientSecret })
  spinner?.stop(install instanceof Error ? install.message : 'Bot installed')
  if (install instanceof Error) return install
  if (!interactive) emitJsonEvent({ type: 'authorized', guild_id: install.guildId })
  // gateway-proxy reloads gateway_clients every 1s (db_config.rs); give it one
  // cycle more so the first IDENTIFY is not rejected.
  await sleep(2_000)
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
}: {
  db: KimakiDb
  // --gateway: use saved gateway credentials, or install the gateway bot.
  gateway: boolean
  restartOnboarding: boolean
}): Promise<ConfigError | DbError | ResolvedCredentials> {
  const envToken = process.env['KIMAKI_BOT_TOKEN']?.trim()
  if (envToken && !gateway && !restartOnboarding) {
    const credentials: Credentials | null = envToken.includes(':')
      ? { mode: 'gateway', appId: GATEWAY_APP_ID, token: envToken, baseUrl: GATEWAY_PROXY_URL }
      : appIdFromToken(envToken)
        ? { mode: 'self_hosted', appId: appIdFromToken(envToken)!, token: envToken, baseUrl: null }
        : null
    if (!credentials) return new ConfigError({ reason: 'KIMAKI_BOT_TOKEN is not a bot token or clientId:secret pair' })
    const saved = await saveCredentials({ db, credentials })
    if (saved instanceof Error) return saved
    return { credentials, install: null }
  }

  if (!restartOnboarding) {
    const saved = await readSavedCredentials({ db, mode: gateway ? 'gateway' : undefined })
    if (saved instanceof Error) return saved
    // Gateway credentials are saved before the install finishes, so the URL
    // stays valid across restarts. Unfinished ones are unknown to the proxy
    // (login fails): continue that install instead of logging in.
    const unfinished = saved?.mode === 'gateway' && !(await isGatewayInstalled(saved))
    if (saved && !unfinished) {
      // Mark as most recently used, so `project add` picks the same bot.
      const touched = await saveCredentials({ db, credentials: saved })
      if (touched instanceof Error) return touched
      return { credentials: saved, install: null }
    }
    if (unfinished) return installGateway({ db })
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
  if (mode === 'gateway') return installGateway({ db })

  const credentials = await promptSelfHostedToken()
  if (credentials instanceof Error) return credentials
  const saved = await saveCredentials({ db, credentials })
  if (saved instanceof Error) return saved
  process.stderr.write(`\nAdd the bot to your server: ${selfHostedInstallUrl({ appId: credentials.appId })}\n\n`)
  return { credentials, install: null }
}
