// Runtime startup and shared helpers for the Kimaki goke CLI.
// Keeps cli.ts focused on command composition while preserving the bot onboarding flow.
import {
  intro,
  outro,
  text,
  password,
  note,
  cancel,
  isCancel,
  confirm,
  log,
  multiselect,
  select,
  spinner,
} from '@clack/prompts'
import {
  deduplicateByKey,
  generateBotInstallUrl,
  generateDiscordInstallUrlForBot,
  KIMAKI_GATEWAY_APP_ID,
  KIMAKI_WEBSITE_URL,
  abbreviatePath,
} from './utils.js'
import {
  getChannelsWithDescriptions,
  createDiscordClient,
  initDatabase,
  getChannelDirectory,
  startDiscordBot,
  initializeOpencodeForDirectory,
  createProjectChannels,
  createDefaultKimakiChannel,
  type ChannelWithTags,
} from './discord-bot.js'
import {
  getBotTokenWithMode,
  ensureServiceAuthToken,
  setBotToken,
  setBotMode,
  setChannelDirectory,
  findChannelsByDirectory,
  getDb,
} from './database.js'
import * as orm from 'drizzle-orm'
import * as dbSchema from './schema.js'
import { selectResolvedCommand } from './opencode-command.js'
import {
  Events,
  ChannelType,
  type Guild,
  type REST,
  Routes,
  AttachmentBuilder,
} from 'discord.js'
import { discordApiUrl, getDiscordRestApiUrl, getGatewayProxyRestBaseUrl, getInternetReachableBaseUrl } from './discord-urls.js'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createLogger, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'
import { uploadFilesToDiscord, stripMentions } from './discord-utils.js'
import { setDataDir, getDataDir } from './config.js'
import { execAsync } from './worktrees.js'
import { backgroundUpgradeKimaki } from './upgrade.js'
import { sendWelcomeMessage } from './onboarding-welcome.js'
import { startHranaServer } from './hrana-server.js'
import { startIpcPolling, stopIpcPolling } from './ipc-polling.js'
import { type ParsedSendAt } from './task-schedule.js'
import { store } from './store.js'
import { registerCommands, SKIP_USER_COMMANDS } from './discord-command-registration.js'

export const cliLogger = createLogger(LogPrefix.CLI)

// Gateway bot mode constants.
// KIMAKI_GATEWAY_APP_ID is the Discord Application ID of the gateway bot.
// KIMAKI_WEBSITE_URL is the website that handles OAuth callback + onboarding status.
// KIMAKI_GATEWAY_PROXY_URL is the gateway-proxy base URL.
// We derive REST base from this URL by swapping ws/wss to http/https.
// These are hardcoded because they're deploy-time constants for the gateway infrastructure.
export const KIMAKI_GATEWAY_PROXY_URL =
  process.env.KIMAKI_GATEWAY_PROXY_URL ||
  'wss://discord-gateway.kimaki.dev'

export const KIMAKI_GATEWAY_PROXY_REST_BASE_URL = getGatewayProxyRestBaseUrl({
  gatewayUrl: KIMAKI_GATEWAY_PROXY_URL,
})

// Strip bracketed paste escape sequences from terminal input.
// iTerm2 and other terminals wrap pasted content with \x1b[200~ and \x1b[201~
// which can cause validation to fail on macOS. See: https://github.com/remorses/kimaki/issues/18
export function stripBracketedPaste(value: string | undefined): string {
  if (!value) {
    return ''
  }
  return value
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    .trim()
}


// Derive the Discord Application ID from a bot token.
// Discord bot tokens have the format: base64(userId).timestamp.hmac
// The first segment is the bot's user ID (= Application ID) base64-encoded.
// For gateway mode tokens (client_id:secret format), this function returns
// undefined -- the caller should use KIMAKI_GATEWAY_APP_ID instead.
export function appIdFromToken(token: string): string | undefined {
  // Gateway mode tokens use "client_id:secret" format, not base64.
  if (token.includes(':')) {
    return undefined
  }
  const segment = token.split('.')[0]
  if (!segment) {
    return undefined
  }
  try {
    const decoded = Buffer.from(segment, 'base64').toString('utf8')
    if (/^\d{17,20}$/.test(decoded)) {
      return decoded
    }
    return undefined
  } catch {
    return undefined
  }
}

// Resolve bot token and app ID from env var or database.
// Used by CLI subcommands (send, project add) that need credentials
// but don't run the interactive wizard.
// In gateway mode, also sets store.discordBaseUrl so REST calls
// are routed through the gateway-proxy REST endpoint.
export async function resolveBotCredentials({ appIdOverride }: { appIdOverride?: string } = {}): Promise<{
  token: string
  appId: string | undefined
}> {
  // DB first: getBotTokenWithMode() sets store.discordBaseUrl which is
  // required in gateway mode so REST calls route through the proxy.
  // Without this, inherited KIMAKI_BOT_TOKEN (a gateway credential like
  // clientId:clientSecret) would be sent directly to discord.com → 401.
  const botRow = await getBotTokenWithMode().catch((e) => {
    cliLogger.error('Database error:', e instanceof Error ? e.message : String(e))
    return null
  })
  if (botRow) {
    return { token: botRow.token, appId: appIdOverride || botRow.appId }
  }

  // Fall back to env var for CI/headless deployments with no database
  const envToken = process.env.KIMAKI_BOT_TOKEN
  if (envToken) {
    const appId = appIdOverride || appIdFromToken(envToken)
    return { token: envToken, appId }
  }

  cliLogger.error('No bot token found. Set KIMAKI_BOT_TOKEN env var or run `kimaki` first to set up.')
  process.exit(EXIT_NO_RESTART)
}

export function isThreadChannelType(type: number): boolean {
  return [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(type)
}

export async function sendDiscordMessageWithOptionalAttachment({
  channelId,
  prompt,
  botToken,
  embeds,
  rest,
}: {
  channelId: string
  prompt: string
  botToken: string
  embeds?: Array<{ color: number; footer: { text: string } }>
  rest: REST
}): Promise<{ id: string }> {
  const discordMaxLength = 2000
  if (prompt.length <= discordMaxLength) {
    return (await rest.post(Routes.channelMessages(channelId), {
      body: { content: prompt, embeds },
    })) as { id: string }
  }

  const preview = prompt.slice(0, 100).replace(/\n/g, ' ')
  const summaryContent = `Prompt attached as file (${prompt.length} chars)\n\n> ${preview}...`

  const tmpDir = path.join(process.cwd(), 'tmp')
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true })
  }
  const tmpFile = path.join(tmpDir, `prompt-${Date.now()}.md`)
  // Wrap long lines so the file is readable in Discord's preview
  // (Discord doesn't wrap text in file attachments)
  const wrappedPrompt = prompt
    .split('\n')
    .flatMap((line) => {
      if (line.length <= 120) {
        return [line]
      }
      const wrapped: string[] = []
      let remaining = line
      const maxCol = 120
      // Only soft-break at a space if it's reasonably close to maxCol,
      // otherwise hard-break to avoid tiny fragments from early spaces
      const minSoftBreak = 90
      while (remaining.length > maxCol) {
        const lastSpace = remaining.lastIndexOf(' ', maxCol)
        const useSoftBreak = lastSpace >= minSoftBreak
        const breakAt = useSoftBreak ? lastSpace : maxCol
        wrapped.push(remaining.slice(0, breakAt))
        // Only consume the separator space on soft breaks
        remaining = useSoftBreak
          ? remaining.slice(breakAt + 1)
          : remaining.slice(breakAt)
      }
      if (remaining.length > 0) {
        wrapped.push(remaining)
      }
      return wrapped
    })
    .join('\n')
  fs.writeFileSync(tmpFile, wrappedPrompt)

  try {
    const formData = new FormData()
    formData.append(
      'payload_json',
      JSON.stringify({
        content: summaryContent,
        attachments: [{ id: 0, filename: 'prompt.md' }],
        embeds,
      }),
    )
    const buffer = fs.readFileSync(tmpFile)
    formData.append(
      'files[0]',
      new Blob([buffer], { type: 'text/markdown' }),
      'prompt.md',
    )

    const starterMessageResponse = await fetch(
      discordApiUrl(`/channels/${channelId}/messages`),
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${botToken}`,
        },
        body: formData,
      },
    )

    if (!starterMessageResponse.ok) {
      const error = await starterMessageResponse.text()
      throw new Error(
        `Discord API error: ${starterMessageResponse.status} - ${error}`,
      )
    }

    return (await starterMessageResponse.json()) as { id: string }
  } finally {
    fs.unlinkSync(tmpFile)
  }
}

export function formatRelativeTime(target: Date): string {
  const diffMs = target.getTime() - Date.now()
  if (diffMs <= 0) {
    return 'due now'
  }

  const totalSeconds = Math.floor(diffMs / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }

  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    return `${totalMinutes}m`
  }

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }

  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

export function formatTaskScheduleLine(schedule: ParsedSendAt): string {
  if (schedule.scheduleKind === 'at') {
    return `one-time at ${schedule.runAt.toISOString()}`
  }
  return `cron "${schedule.cronExpr}" (${schedule.timezone}) next ${schedule.nextRunAt.toISOString()}`
}

export const EXIT_NO_RESTART = 64

export type GuildMemberSearchResult = {
  user: { id: string; username: string; global_name?: string }
  nick?: string
}

export type DiscordUserTarget = {
  id: string
  username: string
}

export function isGuildMemberSearchResult(value: object | null): value is GuildMemberSearchResult {
  if (!value) {
    return false
  }
  const user = Reflect.get(value, 'user')
  return (
    typeof user === 'object' &&
    user !== null &&
    typeof Reflect.get(user, 'id') === 'string' &&
    typeof Reflect.get(user, 'username') === 'string'
  )
}

export function getDiscordUserIdFromUserOption(user: string): string | null {
  const trimmed = user.trim()
  const mentionMatch = trimmed.match(/^<@!?(\d{15,25})>$/)
  if (mentionMatch?.[1]) {
    return mentionMatch[1]
  }
  if (/^\d{15,25}$/.test(trimmed)) {
    return trimmed
  }
  return null
}

function readErrorField(error: object | null, key: string): unknown {
  if (!error) {
    return undefined
  }

  const directValue = Reflect.get(error, key)
  if (directValue !== undefined) {
    return directValue
  }

  const rawError = Reflect.get(error, 'rawError')
  if (typeof rawError === 'object' && rawError !== null) {
    const rawValue = Reflect.get(rawError, key)
    if (rawValue !== undefined) {
      return rawValue
    }
  }

  const cause = Reflect.get(error, 'cause')
  if (typeof cause === 'object' && cause !== null) {
    return readErrorField(cause, key)
  }

  return undefined
}

export function isDiscordMemberLookupUnavailable(error: Error): boolean {
  const status = readErrorField(error, 'status')
  if (status === 403) {
    return true
  }

  const code = readErrorField(error, 'code')
  if (code === 50001 || code === 50013) {
    return true
  }

  const message = String(readErrorField(error, 'message') || '').toLowerCase()
  return (
    (message.includes('missing access') ||
      message.includes('missing permissions') ||
      message.includes('intent')) &&
    message.includes('member')
  )
}

export function formatMemberLookupUnavailableMessage(): string {
  return [
    'Discord member search is unavailable for this bot.',
    'Most Kimaki features still work. Searching names with `--user` needs Server Members Intent.',
    'Use a Discord user ID or raw mention with the same `--user` flag instead:',
    `  kimaki send --channel <channelId> --prompt '...' --user 535922349652836367`,
    `  kimaki send --channel <channelId> --prompt '...' --user '<@535922349652836367>'`,
  ].join('\n')
}

export async function resolveDiscordUserOption({
  user,
  guildId,
  rest,
}: {
  user: string | undefined
  guildId: string
  rest: REST
}): Promise<Error | DiscordUserTarget | undefined> {
  if (!user) {
    return undefined
  }

  const directUserId = getDiscordUserIdFromUserOption(user)
  if (directUserId) {
    cliLogger.log(`Using Discord user ID: ${directUserId}`)
    return { id: directUserId, username: directUserId }
  }

  cliLogger.log(`Searching for user "${user}" in guild...`)
  const searchResult = await rest
    .get(Routes.guildMembersSearch(guildId), {
      query: new URLSearchParams({ query: user, limit: '10' }),
    })
    .catch((error) => new Error('Discord member search failed', { cause: error }))

  if (searchResult instanceof Error) {
    if (isDiscordMemberLookupUnavailable(searchResult)) {
      return new Error(formatMemberLookupUnavailableMessage())
    }
    return searchResult
  }

  const searchResults = Array.isArray(searchResult)
    ? searchResult.filter(isGuildMemberSearchResult)
    : []
  const exactMatch = searchResults.find((member) => {
    const displayName = member.nick || member.user.global_name || member.user.username
    return (
      displayName.toLowerCase() === user.toLowerCase() ||
      member.user.username.toLowerCase() === user.toLowerCase()
    )
  })
  const member = exactMatch || searchResults[0]
  if (!member) {
    return new Error(`User "${user}" not found in guild`)
  }

  const username = member.nick || member.user.global_name || member.user.username
  cliLogger.log(`Found user: ${username} (${member.user.id})`)
  return { id: member.user.id, username }
}

export function canUseInteractivePrompts(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export function exitNonInteractiveSetup(): never {
  cliLogger.error(
    'Setup requires an interactive terminal (TTY) for prompts. Run `kimaki` in an interactive shell to complete setup.',
  )
  process.exit(EXIT_NO_RESTART)
}

// All structured events emitted on stdout in non-TTY mode (cloud sandboxes, CI).
// Consumers parse these with the eventsource-parser npm package.
export type ProgrammaticEvent =
	| { type: 'install_url'; url: string }
	| { type: 'authorized'; guild_id: string }
	| { type: 'ready'; app_id: string; guild_ids: string[] }
	| { type: 'error'; message: string; install_url?: string }

// Emit a structured JSON line on stdout for non-TTY consumers (cloud sandboxes, CI).
// Each line is a self-contained JSON object with a "type" field for easy parsing.
// Lines are prefixed with "data: " and terminated with "\n\n" (SSE format) so consumers
// can use the eventsource-parser npm package to robustly extract JSON events from noisy
// process output (other log lines, warnings, etc. are ignored by the parser).
export function emitJsonEvent(event: ProgrammaticEvent): void {
	process.stdout.write(`data: ${JSON.stringify(event)}\n\n`)
}

export async function resolveGatewayInstallCredentials(): Promise<
  Error | { clientId: string; clientSecret: string; createdNow: boolean }
> {
  if (!KIMAKI_GATEWAY_APP_ID) {
    return new Error(
      'Gateway mode is not available yet. KIMAKI_GATEWAY_APP_ID is not configured.',
    )
  }

  const db = await getDb()
  const gatewayBot = await db.query.bot_tokens.findFirst({
    where: { app_id: KIMAKI_GATEWAY_APP_ID },
  })

  if (gatewayBot?.client_id && gatewayBot.client_secret) {
    return {
      clientId: gatewayBot.client_id,
      clientSecret: gatewayBot.client_secret,
      createdNow: false,
    }
  }

  const clientId = crypto.randomUUID()
  const clientSecret = crypto.randomBytes(32).toString('hex')

  await setBotMode({
    appId: KIMAKI_GATEWAY_APP_ID,
    mode: 'gateway',
    clientId,
    clientSecret,
    proxyUrl: KIMAKI_GATEWAY_PROXY_REST_BASE_URL,
  })

  return {
    clientId,
    clientSecret,
    createdNow: true,
  }
}

export async function printDiscordInstallUrlAndExit({
  gateway,
  gatewayCallbackUrl,
}: {
  gateway?: boolean
  gatewayCallbackUrl?: string
} = {}) {
  await initDatabase()

  if (gateway) {
    const gatewayCredentials = await resolveGatewayInstallCredentials()
    if (gatewayCredentials instanceof Error) {
      cliLogger.error(`Failed to resolve gateway install URL: ${gatewayCredentials.message}`)
      process.exit(EXIT_NO_RESTART)
    }

    const installUrl = generateDiscordInstallUrlForBot({
      appId: KIMAKI_GATEWAY_APP_ID,
      mode: 'gateway',
      clientId: gatewayCredentials.clientId,
      clientSecret: gatewayCredentials.clientSecret,
      gatewayCallbackUrl,
    })
    if (installUrl instanceof Error) {
      cliLogger.error(`Failed to build install URL: ${installUrl.message}`)
      process.exit(EXIT_NO_RESTART)
    }

    cliLogger.log(installUrl)
    if (gatewayCredentials.createdNow) {
      cliLogger.log('Generated and saved new local gateway client credentials.')
    }
    cliLogger.log(
      'This gateway install URL contains your client credentials. Do not share it.',
    )
    process.exit(0)
  }

  const existingBot = await getBotTokenWithMode()

  if (!existingBot) {
    cliLogger.error('No bot configured yet. Run `kimaki` first to set up.')
    process.exit(EXIT_NO_RESTART)
  }

  const installUrl = generateDiscordInstallUrlForBot({
    appId: existingBot.appId,
    mode: existingBot.mode,
    clientId: existingBot.clientId,
    clientSecret: existingBot.clientSecret,
  })
  if (installUrl instanceof Error) {
    cliLogger.error(`Failed to build install URL: ${installUrl.message}`)
    process.exit(EXIT_NO_RESTART)
  }

  cliLogger.log(installUrl)
  if (existingBot.mode === 'gateway') {
    cliLogger.log(
      'This gateway install URL contains your client credentials. Do not share it.',
    )
  }

  process.exit(0)
}

// Detect if a CLI tool is installed, prompt to install if missing.
// Uses official install scripts with platform-specific commands for Unix vs Windows.
// Sets process.env[envPathKey] to the found binary path for the current session.
// After install, re-checks PATH first, then falls back to common install locations.
export async function ensureCommandAvailable({
  name,
  envPathKey,
  installUnix,
  installWindows,
  possiblePathsUnix,
  possiblePathsWindows,
}: {
  name: string
  envPathKey: string
  installUnix: string
  installWindows: string
  possiblePathsUnix: string[]
  possiblePathsWindows: string[]
}): Promise<void> {
  if (process.env[envPathKey]) {
    return
  }

  const isWindows = process.platform === 'win32'
  const whichCmd = isWindows ? 'where' : 'which'
  const isInstalled = await execAsync(`${whichCmd} ${name}`, {
    env: process.env,
  }).then(
    () => {
      return true
    },
    () => {
      return false
    },
  )

  if (isInstalled) {
    return
  }

  note(`${name} is required but not found in your PATH.`, `${name} Not Found`)

  // In non-TTY (cloud sandbox, CI), auto-install without prompting.
  // In interactive mode, ask the user first.
  if (canUseInteractivePrompts()) {
    const shouldInstall = await confirm({
      message: `Would you like to install ${name} right now?`,
    })
    if (isCancel(shouldInstall) || !shouldInstall) {
      cancel(`${name} is required to run this bot`)
      process.exit(EXIT_NO_RESTART)
    }
  } else {
    cliLogger.log(`Auto-installing ${name} (non-interactive mode)...`)
  }

  cliLogger.log(`Installing ${name}...`)

  try {
    // Use explicit shell invocation to avoid Node shell-mode quirks on Windows.
    // PowerShell needs -NoProfile and -ExecutionPolicy Bypass for install scripts.
    // Unix uses login shell (-l) so install scripts can update PATH in shell config.
    const cmd = isWindows ? 'powershell.exe' : '/bin/bash'
    const args = isWindows
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', installWindows]
      : ['-lc', installUnix]
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: 'inherit', env: process.env })
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`${name} install exited with code ${code}`))
        }
      })
      child.on('error', reject)
    })
    cliLogger.log(`${name} installed successfully!`)
  } catch (error) {
    cliLogger.log(`Failed to install ${name}`)
    cliLogger.error(
      'Installation error:',
      error instanceof Error ? error.stack : String(error),
    )
    process.exit(EXIT_NO_RESTART)
  }

  // After install, re-check PATH first (install script may have added it)
  const foundInPath = await execAsync(`${whichCmd} ${name}`, {
    env: process.env,
  }).then(
    (result) => {
      const resolved = selectResolvedCommand({
        output: result.stdout,
        isWindows,
      })
      return resolved || ''
    },
    () => {
      return ''
    },
  )
  if (foundInPath) {
    process.env[envPathKey] = foundInPath
    return
  }

  // Fall back to probing common install locations
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const accessFlag = isWindows ? fs.constants.F_OK : fs.constants.X_OK
  const possiblePaths = (isWindows ? possiblePathsWindows : possiblePathsUnix)
    .filter((p) => {
      return !p.startsWith('~') || home
    })
    .map((p) => {
      return p.replace('~', home)
    })

  const installedPath = possiblePaths.find((p) => {
    try {
      fs.accessSync(p, accessFlag)
      return true
    } catch {
      return false
    }
  })

  if (!installedPath) {
    note(
      `${name} was installed but may not be available in this session.\n` +
        'Please restart your terminal and run this command again.',
      'Restart Required',
    )
    process.exit(EXIT_NO_RESTART)
  }

  process.env[envPathKey] = installedPath
}

// Run opencode upgrade in the background so the user always has the latest version.

// Spawn caffeinate on macOS to prevent system sleep while bot is running.
// Uses -w to watch the parent PID so caffeinate self-terminates if kimaki
// exits for any reason (SIGTERM, crash, process.exit, supervisor stop).
export function startCaffeinate() {
  if (process.platform !== 'darwin') {
    return
  }
  try {
    const proc = spawn('caffeinate', ['-i', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: false,
    })
    proc.unref()
    proc.on('error', (err) => {
      cliLogger.warn('Failed to start caffeinate:', err.message)
    })
    cliLogger.log('Started caffeinate to prevent system sleep')
  } catch (err) {
    cliLogger.warn(
      'Failed to spawn caffeinate:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

// Result of credential resolution. `credentialSource` indicates how the
// credentials were obtained so downstream code can decide whether to show
// channel setup prompts (wizard) or skip them (env/saved/headless).
type CredentialResult = {
  appId: string
  token: string
  credentialSource: 'env' | 'saved' | 'wizard'
  isGatewayMode: boolean
  installerDiscordUserId?: string
}

type CliOptions = {
  restartOnboarding?: boolean
  addChannels?: boolean
  dataDir?: string
  useWorktrees?: boolean
  enableVoiceChannels?: boolean
  gateway?: boolean
  gatewayCallbackUrl?: string
}


export async function collectKimakiChannels({
  guilds,
}: {
  guilds: Guild[]
}): Promise<{ guild: Guild; channels: ChannelWithTags[] }[]> {
  const guildResults = await Promise.all(
    guilds.map(async (guild) => {
      const channels = await getChannelsWithDescriptions(guild)
      const kimakiChans = channels.filter((ch) => ch.kimakiDirectory)

      return { guild, channels: kimakiChans }
    }),
  )

  return guildResults.filter((result) => {
    return result.channels.length > 0
  })
}

/**
 * Store channel-directory mappings in the database.
 * Called after Discord login to persist channel configurations.
 */
export async function storeChannelDirectories({
  kimakiChannels,
}: {
  kimakiChannels: { guild: Guild; channels: ChannelWithTags[] }[]
}): Promise<void> {
  for (const { guild, channels } of kimakiChannels) {
    for (const channel of channels) {
      if (channel.kimakiDirectory) {
        await setChannelDirectory({
          channelId: channel.id,
          directory: channel.kimakiDirectory,
          channelType: 'text',
          skipIfExists: true,
        })

        const voiceChannel = guild.channels.cache.find(
          (ch) =>
            ch.type === ChannelType.GuildVoice && ch.name === channel.name,
        )

        if (voiceChannel) {
          await setChannelDirectory({
            channelId: voiceChannel.id,
            directory: channel.kimakiDirectory,
            channelType: 'voice',
            skipIfExists: true,
          })
        }
      }
    }
  }
}

/**
 * Show the ready message with channel links.
 * Called at the end of startup to display available channels.
 */
export function showReadyMessage({
  kimakiChannels,
  createdChannels,
}: {
  kimakiChannels: { guild: Guild; channels: ChannelWithTags[] }[]
  createdChannels: { name: string; id: string; guildId: string }[]
}): void {
  const allChannels: {
    name: string
    id: string
    guildId: string
    directory?: string
  }[] = []

  allChannels.push(...createdChannels)

  kimakiChannels.forEach(({ guild, channels }) => {
    channels.forEach((ch) => {
      allChannels.push({
        name: ch.name,
        id: ch.id,
        guildId: guild.id,
        directory: ch.kimakiDirectory,
      })
    })
  })

  if (allChannels.length > 0) {
    const channelLinks = allChannels
      .map(
        (ch) =>
          `• #${ch.name}: https://discord.com/channels/${ch.guildId}/${ch.id}`,
      )
      .join('\n')

    note(
      `Your kimaki channels are ready! Click any link below to open in Discord:\n\n${channelLinks}\n\nSend a message in any channel to start using OpenCode!`,
      '🚀 Ready to Use',
    )
  }

  note(
    'Leave this process running to keep the bot active.\n\nIf you close this process or restart your machine, run `npx kimaki` again to start the bot.',
    '⚠️  Keep Running',
  )
}

/**
 * Create the default kimaki channel in each guild and send a welcome message.
 * Idempotent: skips guilds that already have the channel.
 * Extracted so both the interactive and headless startup paths share the same logic.
 */
export async function ensureDefaultChannelsWithWelcome({
  guilds,
  discordClient,
  appId,
  isGatewayMode,
  installerDiscordUserId,
}: {
  guilds: Guild[]
  discordClient: import('discord.js').Client
  appId: string
  isGatewayMode: boolean
  installerDiscordUserId?: string
}): Promise<{ name: string; id: string; guildId: string }[]> {
  const created: { name: string; id: string; guildId: string }[] = []
  for (const guild of guilds) {
    try {
      const result = await createDefaultKimakiChannel({
        guild,
        botName: discordClient.user?.username,
        appId,
        isGatewayMode,
      })
      if (result) {
        created.push({
          name: result.channelName,
          id: result.textChannelId,
          guildId: guild.id,
        })

        // Send welcome message to the newly created default channel.
        // Mention the installer so they get a notification.
        const mentionUserId = installerDiscordUserId || guild.ownerId
        await sendWelcomeMessage({
          channel: result.textChannel,
          mentionUserId,
        })
      }
    } catch (error) {
      cliLogger.warn(
        `Failed to create default kimaki channel in ${guild.name}: ${error instanceof Error ? error.stack : String(error)}`,
      )
    }
  }
  return created
}

/**
 * Background initialization for quick start mode.
 * Starts OpenCode server and registers slash commands without blocking bot startup.
 */
export async function backgroundInit({
  currentDir,
  token,
  appId,
  guildIds,
}: {
  currentDir: string
  token: string
  appId: string
  guildIds: string[]
}): Promise<void> {
  try {
    const opencodeResult = await initializeOpencodeForDirectory(currentDir)
    if (opencodeResult instanceof Error) {
      cliLogger.warn('Background OpenCode init failed:', opencodeResult.message)
      // Still try to register basic commands without user commands/agents
      await registerCommands({
        token,
        appId,
        guildIds,
        userCommands: [],
        agents: [],
      })
      return
    }

    const getClient = opencodeResult

    const [userCommands, agents] = await Promise.all([
      getClient()
        .command.list({ directory: currentDir })
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.warn(
            'Failed to load user commands during background init:',
            error instanceof Error ? error.stack : String(error),
          )
          return []
        }),
      getClient()
        .app.agents({ directory: currentDir })
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.warn(
            'Failed to load agents during background init:',
            error instanceof Error ? error.stack : String(error),
          )
          return []
        }),
    ])

    await registerCommands({ token, appId, guildIds, userCommands, agents })
    cliLogger.log('Slash commands registered!')
  } catch (error) {
    cliLogger.error(
      'Background init failed:',
      error instanceof Error ? error.stack : String(error),
    )
    void notifyError(error, 'Background init failed')
  }
}

// Resolve bot credentials from (in priority order):
// 1. KIMAKI_BOT_TOKEN env var (headless/CI deployments)
// 2. Saved credentials in the database (self-hosted or gateway mode)
// 3. Interactive wizard (gateway OAuth or self-hosted token entry)
//
// credentialSource tells the caller how creds were obtained:
//   'env'    — KIMAKI_BOT_TOKEN env var
//   'saved'  — reused from database
//   'wizard' — user just completed onboarding (gateway OAuth or self-hosted)
export async function resolveCredentials({
  forceRestartOnboarding,
  forceGateway,
  gatewayCallbackUrl,
}: {
  forceRestartOnboarding: boolean
  forceGateway: boolean
  gatewayCallbackUrl?: string
}): Promise<CredentialResult> {
  const envToken = process.env.KIMAKI_BOT_TOKEN
  const existingBot = await getBotTokenWithMode()
  // When --gateway is requested and the resolved bot is still self-hosted,
  // check if saved gateway credentials exist by looking up the gateway app_id
  // directly. This lets users switch back and forth between modes without
  // re-running the onboarding wizard each time.
  const hasGatewayCreds = (forceGateway && existingBot?.mode !== 'gateway')
    ? await (await getDb()).query.bot_tokens.findFirst({
        where: { app_id: KIMAKI_GATEWAY_APP_ID },
      })
    : undefined

  // 1. Env var takes precedence (headless deployments)
  if (envToken && !forceRestartOnboarding && !forceGateway) {
    const derivedAppId = appIdFromToken(envToken)
    if (!derivedAppId) {
      cliLogger.error(
        'Could not derive Application ID from KIMAKI_BOT_TOKEN. The token appears malformed.',
      )
      process.exit(EXIT_NO_RESTART)
    }
    await setBotToken(derivedAppId, envToken)
    cliLogger.log(`Using KIMAKI_BOT_TOKEN env var (App ID: ${derivedAppId})`)
    return { appId: derivedAppId, token: envToken, credentialSource: 'env', isGatewayMode: false }
  }

  // 2. Saved credentials in the database
  // Reuse saved creds unless: --restart-onboarding forces re-setup, or --gateway
  // overrides saved self-hosted creds (saved gateway creds are still used).
  const canReuseSavedCreds = existingBot && !forceRestartOnboarding
    && !(forceGateway && existingBot.mode !== 'gateway')
  if (canReuseSavedCreds) {
    const modeLabel =
      existingBot.mode === 'gateway' ? ' (gateway mode)' : ''
    note(
      `Using saved bot credentials${modeLabel}:\nApp ID: ${existingBot.appId}\n\nTo use different credentials, run with --restart-onboarding`,
      'Existing Bot Found',
    )
    if (existingBot.mode !== 'gateway') {
      note(
        `Bot install URL (in case you need to add it to another server):\n${generateBotInstallUrl({ clientId: existingBot.appId })}`,
        'Install URL',
      )
    }
    return { appId: existingBot.appId, token: existingBot.token, credentialSource: 'saved', isGatewayMode: existingBot.mode === 'gateway' }
  }

  // 2b. Switching to gateway: saved gateway credentials exist from a previous
  // gateway setup. Reuse them without re-running the onboarding wizard.
  if (hasGatewayCreds && !forceRestartOnboarding) {
    const gatewayToken = (hasGatewayCreds.client_id && hasGatewayCreds.client_secret)
      ? `${hasGatewayCreds.client_id}:${hasGatewayCreds.client_secret}`
      : hasGatewayCreds.token
    note(
      `Switching to saved gateway credentials:\nApp ID: ${hasGatewayCreds.app_id}`,
      'Mode Switch',
    )
    return {
      appId: hasGatewayCreds.app_id,
      token: gatewayToken,
      credentialSource: 'saved',
      isGatewayMode: true,
    }
  }

  // 3. Interactive setup wizard (first-time users, --restart-onboarding, or --gateway override).
  //    Non-TTY: gateway mode proceeds headlessly (JSON events on stdout),
  //    self-hosted mode requires interactive prompts so we exit.
  if (!canUseInteractivePrompts() && !forceGateway) {
    exitNonInteractiveSetup()
  }

  if (existingBot && forceGateway && existingBot.mode !== 'gateway') {
    note(
      'Ignoring saved self-hosted credentials due to --gateway flag.\nSwitching to gateway mode.',
      'Gateway Mode',
    )
  } else if (forceRestartOnboarding && existingBot) {
    note('Ignoring saved credentials due to --restart-onboarding flag', 'Restart Onboarding')
  }

  // When --gateway is passed or we're in non-TTY mode, skip the mode selector.
  // Non-TTY without --gateway was already rejected above.
  const modeChoice: 'gateway' | 'self_hosted' = forceGateway
    ? 'gateway'
    : await (async () => {
        const choice = await select({
          message:
            'How do you want to connect to Discord?\n\nGateway: uses Kimaki\'s pre-built bot — no setup, instant. Self-hosted: you create your own Discord bot at discord.com/developers.',
          options: [
            {
              value: 'gateway' as const,
              disabled: true,
              label: 'Gateway (pre-built Kimaki bot, currently disabled because of Discord verification process. will be re-enabled soon)',
            },
            {
              value: 'self_hosted' as const,
              label: 'Self-hosted (your own Discord bot, 5-10 min setup)',
            },
          ],
        })
        if (isCancel(choice)) {
          cancel('Setup cancelled')
          process.exit(0)
        }
        return choice
      })()

  // ── Gateway mode flow ──
  if (modeChoice === 'gateway') {
    if (!KIMAKI_GATEWAY_APP_ID) {
      cliLogger.error(
        'Gateway mode is not available yet. KIMAKI_GATEWAY_APP_ID is not configured.',
      )
      process.exit(EXIT_NO_RESTART)
    }

    const gatewayCredentials = await resolveGatewayInstallCredentials()
    if (gatewayCredentials instanceof Error) {
      throw gatewayCredentials
    }
    const { clientId, clientSecret } = gatewayCredentials

    const oauthUrlResult = generateDiscordInstallUrlForBot({
      appId: KIMAKI_GATEWAY_APP_ID,
      mode: 'gateway',
      clientId,
      clientSecret,
      gatewayCallbackUrl,
      reachableUrl: getInternetReachableBaseUrl() || undefined,
    })
    if (oauthUrlResult instanceof Error) {
      throw oauthUrlResult
    }
    const oauthUrl = oauthUrlResult
    const isInteractive = canUseInteractivePrompts()

    if (isInteractive) {
      note(
        `Open this URL to install the Kimaki bot in your Discord server:\n\n${oauthUrl}\n\nDo not share this URL with anyone — it contains your credentials.\n\nIf you don't have a server, create one first (+ button in the Discord sidebar).`,
        'Install Bot',
      )

      // Open URL in default browser
      const { exec } = await import('node:child_process')
      const openCmd =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open'
      exec(`${openCmd} "${oauthUrl}"`)
    } else {
      // Non-TTY: emit structured JSON so the host process can show the URL to the user.
      emitJsonEvent({ type: 'install_url', url: oauthUrl })
    }

    // Poll until the user installs the bot in a Discord server.
    // 100 attempts x 3s = 5 minutes timeout.
    const s = isInteractive ? spinner() : undefined
    s?.start('Waiting for a Discord server with the bot installed...')

    const pollUrl = new URL('/api/onboarding/status', KIMAKI_WEBSITE_URL)
    pollUrl.searchParams.set('client_id', clientId)
    pollUrl.searchParams.set('secret', clientSecret)

    let guildId: string | undefined
    let installerDiscordUserId: string | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => {
        setTimeout(resolve, 3000)
      })

      // Progressive hints for interactive users who may be stuck
      if (isInteractive) {
        if (attempt === 15) {
          s?.message(
            'Still waiting... Select a server in the Discord authorization page and click "Authorize"',
          )
        } else if (attempt === 45) {
          s?.message(
            `Still waiting... If you don't see any servers, create one first (+ button in Discord sidebar), then reopen the URL above`,
          )
        } else if (attempt === 150) {
          s?.message(
            `Still waiting... Reopen the install URL if you closed it:\n${oauthUrl}`,
          )
        }
      }

      try {
        const resp = await fetch(pollUrl.toString())
        if (resp.ok) {
          const data = (await resp.json()) as {
            guild_id?: string
            discord_user_id?: string
          } | null
          if (data?.guild_id) {
            guildId = data.guild_id
            installerDiscordUserId = data.discord_user_id
            break
          }
        }
      } catch {
        // Network error, retry
      }
    }

    if (!guildId) {
      if (isInteractive) {
        s?.stop('Authorization timed out')
      } else {
        emitJsonEvent({ type: 'error', message: 'Authorization timed out after 5 minutes' })
      }
      cliLogger.error(
        'Bot authorization timed out after 5 minutes. Please try again.',
      )
      process.exit(EXIT_NO_RESTART)
    }

    if (isInteractive) {
      s?.stop('Bot authorized successfully!')
      const syncSpinner = spinner()
      syncSpinner.start('Waiting for gateway sync...')
      await new Promise((resolve) => {
        setTimeout(resolve, 2000)
      })
      syncSpinner.stop('Gateway sync completed')
    } else {
      emitJsonEvent({ type: 'authorized', guild_id: guildId })
      await new Promise((resolve) => {
        setTimeout(resolve, 2000)
      })
    }

    return {
      appId: KIMAKI_GATEWAY_APP_ID,
      token: `${clientId}:${clientSecret}`,
      credentialSource: 'wizard',
      isGatewayMode: true,
      installerDiscordUserId,
    }
  }

  // ── Self-hosted mode flow (existing wizard) ──
  note(
    '1. Go to https://discord.com/developers/applications\n' +
      '2. Click "New Application"\n' +
      '3. Give your application a name',
    'Step 1: Create Discord Application',
  )

  note(
    '1. Go to the "Bot" section in the left sidebar\n' +
      '2. Scroll down to "Privileged Gateway Intents"\n' +
      '3. Enable MESSAGE CONTENT INTENT by toggling it ON\n' +
      '4. Optional: enable SERVER MEMBERS INTENT only if you want name lookup in `kimaki user list` and `kimaki send --user Tommy`\n' +
      '5. Click "Save Changes" at the bottom',
    'Step 2: Enable Message Content Intent',
  )

  const intentsConfirmed = await text({
    message: 'Press Enter after enabling Message Content Intent:',
    placeholder: 'Enter',
  })
  if (isCancel(intentsConfirmed)) {
    cancel('Setup cancelled')
    process.exit(0)
  }

  note(
    '1. Still in the "Bot" section\n' +
      '2. Click "Reset Token" to generate a new bot token (in case of errors try again)\n' +
      "3. Copy the token (you won't be able to see it again!)",
    'Step 3: Get Bot Token',
  )
  const tokenInput = await password({
    message:
      'Enter your Discord Bot Token (from "Bot" section - click "Reset Token" if needed):',
    validate(value) {
      const cleaned = stripBracketedPaste(value)
      if (!cleaned) {
        return 'Bot token is required'
      }
      if (cleaned.length < 50) {
        return 'Invalid token format (too short)'
      }
    },
  })
  if (isCancel(tokenInput)) {
    cancel('Setup cancelled')
    process.exit(0)
  }

  const wizardToken = stripBracketedPaste(tokenInput)
  const derivedAppId = appIdFromToken(wizardToken)
  if (!derivedAppId) {
    cliLogger.error(
      'Could not derive Application ID from the bot token. The token appears malformed.',
    )
    process.exit(EXIT_NO_RESTART)
  }

  await setBotToken(derivedAppId, wizardToken)

  note(
    `Bot install URL:\n${generateBotInstallUrl({ clientId: derivedAppId })}\n\nYou MUST install the bot in your Discord server before continuing.`,
    'Step 4: Install Bot to Server',
  )
  const installed = await text({
    message: 'Press Enter AFTER you have installed the bot in your server:',
    placeholder: 'Enter',
  })
  if (isCancel(installed)) {
    cancel('Setup cancelled')
    process.exit(0)
  }

  return { appId: derivedAppId, token: wizardToken, credentialSource: 'wizard', isGatewayMode: false }
}

export async function run({
  restartOnboarding,
  addChannels,
  useWorktrees,
  enableVoiceChannels,
  gateway,
  gatewayCallbackUrl,
}: CliOptions) {
  startCaffeinate()

  const forceRestartOnboarding = Boolean(restartOnboarding)
  const forceGateway = Boolean(gateway)

  // Step 0: Ensure bun is installed. OpenCode is downloaded on first run
  // to ~/.kimaki/bin/ (pinned version), so no install check is needed.
  await ensureCommandAvailable({
    name: 'bun',
    envPathKey: 'BUN_PATH',
    installUnix: 'curl -fsSL https://bun.sh/install | bash',
    installWindows: 'irm bun.sh/install.ps1 | iex',
    possiblePathsUnix: ['~/.bun/bin/bun', '/usr/local/bin/bun'],
    possiblePathsWindows: ['~\\.bun\\bin\\bun.exe'],
  })


  void backgroundUpgradeKimaki()

  // Start in-process Hrana server before database init. Required for the bot
  // process because it serves as both the DB server and the single-instance
  // lock (binds the fixed lock port). Without it, IPC and lock enforcement
  // don't work. CLI subcommands skip the server and use file: directly.
  const hranaResult = await startHranaServer({
    dbPath: path.join(getDataDir(), 'discord-sessions.db'),
    bindAll: getInternetReachableBaseUrl() !== null,
  })
  if (hranaResult instanceof Error) {
    cliLogger.error('Failed to start hrana server:', hranaResult.message)
    process.exit(EXIT_NO_RESTART)
  }

  // Initialize database (connects to hrana server via HTTP)
  await initDatabase()

  const { appId, token, credentialSource, isGatewayMode, installerDiscordUserId } = await resolveCredentials({
    forceRestartOnboarding,
    forceGateway,
    gatewayCallbackUrl,
  })

  const gatewayToken = await ensureServiceAuthToken({
    appId,
    preferredGatewayToken: isGatewayMode ? token : undefined,
  })
  // Always set service auth token so local and internet control-plane paths
  // share one auth model (/kimaki/wake and future service endpoints).
  store.setState({ gatewayToken })

  // In gateway mode, ensure REST calls route through the gateway proxy.
  // getBotTokenWithMode() sets this for saved-credential paths, but the fresh
  // onboarding path returns directly without going through getBotTokenWithMode(),
  // leaving store.discordBaseUrl at the default 'https://discord.com'.
  // Without this, discord.js sends the clientId:clientSecret token to Discord
  // directly, which rejects it with "An invalid token was provided".
  if (isGatewayMode) {
    store.setState({ discordBaseUrl: KIMAKI_GATEWAY_PROXY_REST_BASE_URL })
  }

  // When KIMAKI_INTERNET_REACHABLE_URL is set, the hrana server exposes
  // a /kimaki/wake endpoint for the gateway-proxy to wake this instance and
  // wait until discord.js is connected. Keep Discord traffic on the normal
  // configured base URL (gateway-proxy in gateway mode).
  if (getInternetReachableBaseUrl()) {
    cliLogger.log('Internet-reachable mode: enabling /kimaki/wake endpoint on hrana server')
  }

  // Start OpenCode server as early as possible — non-blocking.
  // All dependencies are met (dataDir, lockPort, gatewayToken, hranaUrl set).
  // Runs in parallel with last_used_at update, skipChannelSetup check, and
  // Discord Gateway login so cold start is not blocked by OpenCode spawn.
  const currentDir = process.cwd()
  cliLogger.log('Starting OpenCode server...')
  const opencodePromise = initializeOpencodeForDirectory(currentDir).then(
    (result) => {
      if (result instanceof Error) {
        throw new Error(result.message)
      }
      cliLogger.log('OpenCode server ready!')
      return result
    },
  )
  // Prevent unhandled rejection if OpenCode fails before backgroundInit
  // or the channel setup path awaits it. Errors are handled by the
  // respective consumers (backgroundInit catches, channel setup re-throws).
  opencodePromise.catch(() => {})

  // Mark this bot as the most recently used so subcommands in separate
  // processes (send, upload-to-discord, project list) pick the correct bot.
  // getBotTokenWithMode() orders by last_used_at DESC as cross-process
  // source of truth.
  await (await getDb()).update(dbSchema.bot_tokens)
    .set({ last_used_at: new Date() })
    .where(orm.eq(dbSchema.bot_tokens.app_id, appId))

  // skipChannelSetup: when true, skip interactive project/channel selection
  // and go straight to bot startup. Channel sync happens in the background.
  //
  // Skip when: creds came from env/saved (not first-time wizard), OR non-TTY
  // gateway (headless), OR user didn't pass --add-channels/--restart-onboarding.
  // Force channel setup when: first-time quick-start with no channels configured
  // and TTY is available, or user explicitly passed --add-channels.
  const isHeadlessGateway = isGatewayMode && !canUseInteractivePrompts()
  const hasConfiguredTextChannels = Boolean(
    await (await getDb()).query.channel_directories.findFirst({
      where: { channel_type: 'text' },
      columns: { channel_id: true },
    }),
  )
  const skipChannelSetup = isHeadlessGateway || (() => {
    // Wizard source always shows channel setup (user just completed onboarding)
    if (credentialSource === 'wizard') {
      return false
    }
    // Env/saved source: skip unless user explicitly asked for channels
    if (forceRestartOnboarding || Boolean(addChannels)) {
      return false
    }
    // First-time quick start with no channels: force setup if TTY is available
    if (!hasConfiguredTextChannels && canUseInteractivePrompts()) {
      return false
    }
    return true
  })()

  cliLogger.log(`Connecting to ${getDiscordRestApiUrl()}...`)
  const discordClient = await createDiscordClient()

  const guilds: Guild[] = []
  const kimakiChannels: { guild: Guild; channels: ChannelWithTags[] }[] = []
  const createdChannels: { name: string; id: string; guildId: string }[] = []

  try {
    await new Promise((resolve, reject) => {
      discordClient.once(Events.ClientReady, async (c) => {
        // Guild discovery comes from the Gateway WebSocket READY payload, not
        // from a separate REST fetch. discord.js consumes READY and hydrates
        // client.guilds.cache from d.guilds. In gateway mode, gateway-proxy
        // already filters this list to authorized guilds for client_id:secret.
        // Example payload fragment received over WS:
        // {
        //   "op": 0,
        //   "t": "READY",
        //   "d": {
        //     "guilds": [
        //       { "id": "123456789012345678", "unavailable": false }
        //     ]
        //   }
        // }
        guilds.push(...Array.from(c.guilds.cache.values()))

        if (skipChannelSetup) {
          resolve(null)
          return
        }

        // Process guild metadata when setup flow needs channel prompts.
        const guildResults = await collectKimakiChannels({ guilds })

        // Collect results
        for (const result of guildResults) {
          kimakiChannels.push(result)
        }

        resolve(null)
      })

      discordClient.once(Events.Error, reject)

      discordClient.login(token).catch(reject)
    })

    cliLogger.log('Connected to Discord!')
    // Start IPC polling now that Discord client is ready.
    // Register cleanup on process exit since the shutdown handler lives in discord-bot.ts.
    await startIpcPolling({ discordClient })
    process.on('exit', stopIpcPolling)
  } catch (error) {
    cliLogger.log('Failed to connect to Discord', discordClient.ws.gateway)
    cliLogger.error(
      'Error: ' + (error instanceof Error ? error.stack : String(error)),
    )
    process.exit(EXIT_NO_RESTART)
  }
  await setBotToken(appId, token)

   // In gateway mode the bot only sees guilds the user has installed
  // it in. Zero guilds means the install URL callback never completed or the
  // user removed the bot from all servers — there is nothing the bot can do.
  if (isGatewayMode && guilds.length === 0) {
    // Rebuild the install URL from the current credentials so the user can
    // add the bot to a server without going through the full --restart-onboarding flow.
    const [clientId, clientSecret] = token.split(':')
    if (!clientId || !clientSecret) {
      throw new Error('Malformed gateway token: expected clientId:clientSecret format')
    }
    const installUrlResult = generateDiscordInstallUrlForBot({
      appId: KIMAKI_GATEWAY_APP_ID,
      mode: 'gateway',
      clientId,
      clientSecret,
    })
    if (installUrlResult instanceof Error) {
      throw installUrlResult
    }
    const installUrl = installUrlResult
    if (!canUseInteractivePrompts()) {
      emitJsonEvent({ type: 'error', message: 'No Discord servers found', install_url: installUrl })
    }
    cliLogger.error(
      'No Discord servers found. The bot must be installed in at least one server.\n' +
        `Install URL: ${installUrl}\n` +
        'Do not share this URL with anyone — it contains your credentials.\n' +
        'Open the URL above to add the bot to a server, then run kimaki again.',
    )
    void discordClient.destroy()
    process.exit(EXIT_NO_RESTART)
  }

  if (skipChannelSetup) {
    // Start bot immediately — channel sync happens in the background.
    cliLogger.log('Starting Discord bot...')
    await startDiscordBot({ token, appId, discordClient, useWorktrees })
    cliLogger.log('Discord bot is running!')

    // Background channel sync + role reconciliation + default channel creation.
    // Never blocks ready state.
    void (async () => {
      try {
        const backgroundChannels = await collectKimakiChannels({ guilds })
        await storeChannelDirectories({ kimakiChannels: backgroundChannels })
        cliLogger.log(
          `Background channel sync completed for ${backgroundChannels.length} guild(s)`,
        )
      } catch (error) {
        cliLogger.warn(
          'Background channel sync failed:',
          error instanceof Error ? error.stack : String(error),
        )
      }

      // Create default kimaki channel + welcome message in each guild.
      // Runs after channel sync so existing channels are detected correctly.
      try {
        await ensureDefaultChannelsWithWelcome({
          guilds,
          discordClient,
          appId,
          isGatewayMode,
          installerDiscordUserId,
        })
      } catch (error) {
        cliLogger.warn(
          'Background default channel creation failed:',
          error instanceof Error ? error.stack : String(error),
        )
      }
    })()

    // Background: OpenCode init + slash command registration (non-blocking)
    void backgroundInit({
      currentDir,
      token,
      appId,
      guildIds: guilds.map((guild) => {
        return guild.id
      }),
    })
  } else {
    // ── Channel setup flow ──
    // Store channel-directory mappings discovered during Discord login.
    await storeChannelDirectories({ kimakiChannels })

    if (!hasConfiguredTextChannels) {
      note(
        'No Kimaki project channels are configured yet. Opening project/channel setup.',
        'Channel Setup',
      )
    }

    if (kimakiChannels.length > 0) {
      const channelList = kimakiChannels
        .flatMap(({ guild, channels }) =>
          channels.map((ch) => {
            return `#${ch.name} in ${guild.name}: ${ch.kimakiDirectory}`
          }),
        )
        .join('\n')

      note(channelList, 'Existing Kimaki Channels')
    }

    // Wait for OpenCode, fetch projects, show prompts, create channels if needed
    cliLogger.log('Waiting for OpenCode server...')
    const getClient = await opencodePromise

    cliLogger.log('Fetching OpenCode data...')

    // Fetch projects, commands, and agents in parallel
    const [projects, allUserCommands, allAgents] = await Promise.all([
      getClient()
        .project.list()
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.log('Failed to fetch projects')
          cliLogger.error(
            'Error:',
            error instanceof Error ? error.stack : String(error),
          )
          void discordClient.destroy()
          process.exit(EXIT_NO_RESTART)
        }),
      getClient()
        .command.list({ directory: currentDir })
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.warn(
            'Failed to load user commands during setup:',
            error instanceof Error ? error.stack : String(error),
          )
          return []
        }),
      getClient()
        .app.agents({ directory: currentDir })
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.warn(
            'Failed to load agents during setup:',
            error instanceof Error ? error.stack : String(error),
          )
          return []
        }),
    ])

    cliLogger.log(`Found ${projects.length} OpenCode project(s)`)

    const existingDirs = kimakiChannels.flatMap(({ channels }) =>
      channels
        .filter((ch) => ch.kimakiDirectory)
        .map((ch) => ch.kimakiDirectory)
        .filter(Boolean),
    )

    const availableProjects = deduplicateByKey(
      projects.filter((project) => {
        if (existingDirs.includes(project.worktree)) {
          return false
        }
        if (path.basename(project.worktree).startsWith('opencode-test-')) {
          return false
        }
        return true
      }),
      (x) => x.worktree,
    )

    if (availableProjects.length === 0) {
      note(
        'All OpenCode projects already have Discord channels',
        'No New Projects',
      )
    }

    if (availableProjects.length > 0) {
      if (!canUseInteractivePrompts()) {
        exitNonInteractiveSetup()
      }

      const selectedProjects = await multiselect({
        message: 'Select projects to create Discord channels for:',
        options: availableProjects.map((project) => ({
          value: project.id,
          label: `${path.basename(project.worktree)} (${abbreviatePath(project.worktree)})`,
        })),
        required: false,
      })

      if (!isCancel(selectedProjects) && selectedProjects.length > 0) {
        let targetGuild: Guild
        if (guilds.length === 0) {
          cliLogger.error(
            'No Discord servers found! The bot must be installed in at least one server.',
          )
          process.exit(EXIT_NO_RESTART)
        }

        if (guilds.length === 1) {
          targetGuild = guilds[0]!
          note(`Using server: ${targetGuild.name}`, 'Server Selected')
        } else {
          const guildSelection = await multiselect({
            message: 'Select a Discord server to create channels in:',
            options: guilds.map((guild) => ({
              value: guild.id,
              label: `${guild.name} (${guild.memberCount} members)`,
            })),
            required: true,
            maxItems: 1,
          })

          if (isCancel(guildSelection)) {
            cancel('Setup cancelled')
            process.exit(0)
          }

          targetGuild = guilds.find((g) => g.id === guildSelection[0])!
        }

        cliLogger.log('Creating Discord channels...')

        for (const projectId of selectedProjects) {
          const project = projects.find((p) => p.id === projectId)
          if (!project) continue

          try {
            const { textChannelId, channelName } = await createProjectChannels({
              guild: targetGuild,
              projectDirectory: project.worktree,
              botName: discordClient.user?.username,
              enableVoiceChannels,
            })

            createdChannels.push({
              name: channelName,
              id: textChannelId,
              guildId: targetGuild.id,
            })
          } catch (error) {
            cliLogger.error(
              `Failed to create channels for ${path.basename(project.worktree)}:`,
              error,
            )
          }
        }

        cliLogger.log(`Created ${createdChannels.length} channel(s)`)

        if (createdChannels.length > 0) {
          note(
            createdChannels.map((ch) => `#${ch.name}`).join('\n'),
            'Created Channels',
          )
        }
      }
    }

    // Create default kimaki channel for general-purpose tasks.
    // Runs for every guild the bot is in, idempotent (skips if already exists).
    const defaultChannelResults = await ensureDefaultChannelsWithWelcome({
      guilds,
      discordClient,
      appId,
      isGatewayMode,
      installerDiscordUserId,
    })
    createdChannels.push(...defaultChannelResults)

    // Log available user commands
    const registrableCommands = allUserCommands.filter(
      (cmd) => !SKIP_USER_COMMANDS.includes(cmd.name),
    )

    if (registrableCommands.length > 0) {
      note(
        `Found ${registrableCommands.length} user-defined command(s)`,
        'OpenCode Commands/Skills',
      )
    }

    cliLogger.log('Registering slash commands asynchronously...')
    void registerCommands({
      token,
      appId,
      guildIds: guilds.map((guild) => {
        return guild.id
      }),
      userCommands: allUserCommands,
      agents: allAgents,
    })
      .then(() => {
        cliLogger.log('Slash commands registered!')
      })
      .catch((error) => {
        cliLogger.error(
          'Failed to register slash commands:',
          error instanceof Error ? error.stack : String(error),
        )
      })

    // Start bot after channel setup is complete so it doesn't handle
    // messages/interactions while the user is still going through prompts.
    cliLogger.log('Starting Discord bot...')
    await startDiscordBot({ token, appId, discordClient, useWorktrees })
    cliLogger.log('Discord bot is running!')
  }

  // ── Ready ──
  if (!canUseInteractivePrompts()) {
    emitJsonEvent({
      type: 'ready',
      app_id: appId,
      guild_ids: guilds.map((g) => { return g.id }),
    })
  } else {
    showReadyMessage({ kimakiChannels, createdChannels })
    outro('✨ Bot ready! Listening for messages...')
  }
}
