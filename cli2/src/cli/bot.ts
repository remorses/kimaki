// Bot lifecycle and setup: the root command (start + onboarding), provider
// login, tools (tunnel, tts), and bot status, logs, credentials and keys.
// main.ts, onboarding.ts and traforo are loaded only by the commands that run them.

import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import dedent from 'string-dedent'
import type { Goke } from 'goke'

import { createAnalytics } from '../analytics.ts'
import { emitEvent, gatewayCredentials, gatewayUrlsFromEnv, installUrlFor, readSavedCredentials, resolveCredentials, restApiUrl } from '../credentials.ts'
import { openDb } from '../db.ts'
import { callBot, DEFAULT_LOCK_PORT } from '../lock-server.ts'
import { createLogger } from '../logger.ts'
import { opencodeConfigDir } from '../opencode-server.ts'
import { defaultMachineName } from '../project.ts'
import { audioKeyCandidates, generateSpeech, saveAudioKeys } from '../voice.ts'
import { action, DATA_DIR_HELP, dataDirOrDefault, discordApi, fail, openCliDb, printJson } from './shared.ts'

const logger = createLogger('CLI')

// Non-TTY hosts get the failure as an `error` event too (programmatic onboarding).
function failStartup(error: Error, installUrl?: string): never {
  if (!process.stdin.isTTY) emitEvent({ type: 'error', message: error.message, ...(installUrl && { install_url: installUrl }) })
  fail(error)
}

// null when the file vanished meanwhile (bot restart).
async function readRange({ file, start, end }: { file: string; start: number; end: number }): Promise<Buffer | null> {
  const handle = await fs.promises.open(file, 'r').catch(() => null)
  if (!handle) return null
  const buffer = Buffer.alloc(end - start)
  const read = await handle.read(buffer, 0, buffer.length, start).catch(() => null)
  await handle.close().catch(() => undefined)
  return read ? buffer.subarray(0, read.bytesRead) : null
}

// tail -f that survives the bot truncating the file on restart.
async function followFile(file: string): Promise<never> {
  const position = { offset: 0 }
  while (true) {
    const size = await fs.promises.stat(file).then((stat) => stat.size).catch(() => 0)
    if (size < position.offset) position.offset = 0
    if (size > position.offset) {
      const chunk = await readRange({ file, start: position.offset, end: size })
      if (chunk) process.stdout.write(chunk)
      position.offset = size
    }
    await sleep(300)
  }
}

// `kimaki2` with no subcommand.
export function registerStartCommand(cli: Goke) {
  cli.command('', 'Start the bot. Runs onboarding on first start')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-g, --guild <guildId>', 'Server to onboard when the bot is in several')
    .option('--gateway', 'Use the shared Kimaki bot, no Discord app needed')
    .option('--gateway-callback-url <url>', 'Redirect here after the gateway install (appends ?guild_id=<id>)')
    .option('--install-url', 'Print the install URL and exit (non-interactive onboarding)')
    .option('--machine-name <name>', 'Name in this machine\'s category "Kimaki <name>" (default: hostname)')
    .option('--restart-onboarding', 'Choose credentials again')
    .option('--worktrees', 'Use a fresh Git worktree for new sessions unless the channel overrides it')
    .option('--no-analytics', 'Disable anonymous usage analytics (same as KIMAKI_STRADA_ENABLED=0)')
    .action(async (options) => {
      // Bot code loads only here: the other subcommands start without it.
      const [{ startBot }, { chooseGuild, kimakiShellCommand, runOnboarding, startCaffeinate }] = await Promise.all([import('../main.ts'), import('../onboarding.ts')])
      const dataDir = dataDirOrDefault(options.dataDir)
      const urls = gatewayUrlsFromEnv()
      const machine = options.machineName ?? defaultMachineName()
      const opened = await openDb({ dataDir, migrate: true })
      if (opened instanceof Error) failStartup(opened)

      if (options.installUrl) {
        const credentials = options.gateway
          ? await gatewayCredentials({ db: opened.db, urls })
          : await readSavedCredentials({ db: opened.db })
        opened.close()
        if (credentials instanceof Error) fail(credentials)
        if (!credentials) fail(new Error('No bot configured yet. Run kimaki first, or pass --gateway.'))
        process.stdout.write(`${installUrlFor({ credentials, website: urls.website, callbackUrl: options.gatewayCallbackUrl })}\n`)
        if (credentials.mode === 'gateway') process.stderr.write('This URL contains your client credentials. Do not share it.\n')
        return
      }

      startCaffeinate()
      const resolved = await resolveCredentials({
        db: opened.db,
        gateway: Boolean(options.gateway),
        restartOnboarding: Boolean(options.restartOnboarding),
        urls,
        callbackUrl: options.gatewayCallbackUrl,
      })
      opened.close()
      if (resolved instanceof Error) failStartup(resolved)
      const { credentials, install } = resolved
      const installUrl = installUrlFor({ credentials, website: urls.website, callbackUrl: options.gatewayCallbackUrl })
      // The agent calls this same install: same node, loader flags and script.
      const kimaki = kimakiShellCommand({
        command: [process.execPath, ...process.execArgv, process.argv[1] ?? 'kimaki2'],
        dataDir,
      })

      const bot = await startBot({
        kimakiCommand: kimaki,
        dataDir,
        token: credentials.token,
        discordRestUrl: restApiUrl(credentials),
        lockPort: Number(process.env['KIMAKI_LOCK_PORT'] || DEFAULT_LOCK_PORT),
        opencodeServiceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'],
        ensureOpencode: true,
        opencodeConfigDir: opencodeConfigDir(),
        analytics: createAnalytics({ dataDir, botMode: credentials.mode, enabled: !options.noAnalytics }),
        autoWorktrees: Boolean(options.worktrees),
      })
      if (bot instanceof Error) failStartup(bot)
      const shutdown = () => {
        void bot.stop().then(() => process.exit(0))
      }
      process.once('SIGTERM', shutdown)
      process.once('SIGINT', shutdown)

      const gateway = credentials.mode === 'gateway'
      const guild = await chooseGuild({ discord: bot.discord, guildId: options.guild ?? install?.guildId, installUrl, gateway })
      if (guild instanceof Error) {
        await bot.stop()
        failStartup(guild, installUrl)
      }
      const onboarded = await runOnboarding({ bot, dataDir, guild, kimaki, gateway, installerId: install?.installerId, machine })
      // The bot keeps running; the next start retries onboarding.
      if (onboarded instanceof Error) {
        logger.error(`onboarding failed: ${onboarded.message}`)
        if (!process.stdin.isTTY) emitEvent({ type: 'error', message: `Onboarding failed: ${onboarded.message}. The bot is running; restart kimaki to retry.` })
        return
      }
      if (onboarded) process.stderr.write(`Onboarding thread: https://discord.com/channels/${guild.id}/${onboarded.threadId}\n`)
      if (!process.stdin.isTTY) emitEvent({ type: 'ready', app_id: credentials.appId, guild_ids: [...bot.discord.guilds.cache.keys()] })
    })
}

// login, login credential: OpenCode provider credentials through the bot.
export function registerLoginCommands(cli: Goke) {
  cli.command('login <provider>', 'Connect a provider using OpenCode integration credentials')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--key <key>', 'API key to store in OpenCode')
    .option('--method <id>', 'OAuth method ID; without flags, list login methods')
    .option('--attempt <id>', 'Check or complete this native OAuth attempt')
    .option('--code <code>', 'Authorization code for the attempt')
    .option('--cancel', 'Cancel the native OAuth attempt')
    .action(async (provider, options) => {
      await action({ route: 'login', dataDir: options.dataDir, input: {
        provider, key: options.key, method: options.method, attempt: options.attempt, code: options.code, ...(options.cancel && { operation: 'cancel' }),
      } })
    })

  cli.command('login credential <id>', 'Activate, remove, or label an OpenCode credential')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--operation <name>', 'activate | remove | label')
    .option('--label <text>', 'Credential label')
    .action(async (id, options) => {
      await action({ route: 'credential', dataDir: options.dataDir, input: { id, operation: options.operation ?? 'activate', label: options.label } })
    })
}

// tunnel, tts
export function registerToolCommands(cli: Goke) {
  cli.command('tunnel', 'Run a command and expose its local port with a public URL. The child gets TRAFORO_URL')
    .option('-p, --port <port>', 'Local port (default: read from the command output)')
    .option('-t, --tunnel-id <id>', 'Fixed tunnel ID (default: random). Only for public-safe services')
    .option('--host <host>', 'Local host (default: localhost)')
    .option('-k, --kill', 'Kill the process on --port first')
    .example('kimaki tunnel -- pnpm dev')
    .action(async (options) => {
      const command = options['--'] ?? []
      const port = options.port ? Number(options.port) : undefined
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) fail(new Error(`Invalid --port ${options.port}`))
      if (!port && command.length === 0) fail(new Error('Pass a command after --, or --port <port>. Example: kimaki tunnel -- pnpm dev'))
      const { runTunnel } = await import('traforo/run-tunnel')
      await runTunnel({ port, command: command.length > 0 ? command : undefined, tunnelId: options.tunnelId, localHost: options.host, baseDomain: 'kimaki.dev', kill: options.kill })
    })

  cli.command('tts [text]', 'Text to speech with OpenAI or Gemini. Reads stdin if no text is given')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-o, --output <path>', 'Output file (default: speech.mp3 or speech.wav)')
    .option('-p, --provider <name>', 'openai | gemini (default: from the stored key)')
    .option('-v, --voice <voice>', 'Voice ID (default: alloy for OpenAI, Kore for Gemini)')
    .option('-i, --instructions <text>', 'Style instructions (OpenAI only)')
    .option('--speed <n>', '0.25 to 4.0 (OpenAI only, default: 1.25)')
    .action(async (text, options) => {
      const chunks: Buffer[] = []
      if (!text && !process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
      const input = text ?? Buffer.concat(chunks).toString('utf8').trim()
      if (!input) fail(new Error('Pass the text as an argument or pipe it via stdin'))
      if (options.provider && options.provider !== 'openai' && options.provider !== 'gemini') fail(new Error('--provider must be openai or gemini'))
      const speed = options.speed ? Number(options.speed) : 1.25
      if (!(speed >= 0.25 && speed <= 4)) fail(new Error('--speed must be between 0.25 and 4'))
      // Any stored bot_api_keys row (imported from V1 /transcription-key); a missing database only skips it.
      const opened = await openDb({ dataDir: dataDirOrDefault(options.dataDir), migrate: false })
      const stored = opened instanceof Error ? null : await opened.db.query.bot_api_keys.findFirst().catch(() => null)
      if (!(opened instanceof Error)) opened.close()
      const key = audioKeyCandidates(stored).find((candidate) => !options.provider || candidate.provider === options.provider)
      if (!key) fail(new Error('No OpenAI or Gemini key. Set OPENAI_API_KEY or GEMINI_API_KEY'))
      const result = await generateSpeech({ text: input, apiKey: key.apiKey, provider: key.provider, voice: options.voice, instructions: options.instructions, speed })
      if (result instanceof Error) fail(result)
      const output = path.resolve(options.output ?? `speech.${result.mediaType === 'audio/mp3' ? 'mp3' : 'wav'}`)
      await fs.promises.writeFile(output, result.audio)
      process.stdout.write(`${output}\n`)
    })
}

// status, logs, bot token / keys set / install-url
export function registerBotCommands(cli: Goke) {
  cli.command('status', 'Bot health: running, pid, uptime, OpenCode URL and version, guilds')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'status', input: {} })
      if (result instanceof Error) {
        process.stdout.write(options.json ? `${JSON.stringify({ running: false, reason: result.message })}\n` : `not running: ${result.message}\n`)
        process.exitCode = 1
        return
      }
      const status = { running: true, ...result.data }
      if (options.json) return printJson(status)
      process.stdout.write(dedent`
        running: pid ${status.pid}, up ${status.uptimeSec}s, mode ${JSON.stringify(status.mode)}
        opencode: ${JSON.stringify(status.opencode)}
        guilds: ${JSON.stringify(status.guilds)}
        data dir: ${JSON.stringify(status.dataDir)}
      ` + '\n')
    })

  cli.command('logs', 'Print the log file path. The bot resets the file on every start')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-f, --follow', 'Print the log and keep printing new lines')
    .action(async (options) => {
      const file = path.join(dataDirOrDefault(options.dataDir), 'kimaki.log')
      if (!options.follow) {
        process.stdout.write(`${file}\n`)
        return
      }
      await followFile(file)
    })

  cli.command('bot token', 'Print saved bot credentials for automation')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => process.stdout.write(`${(await discordApi(options.dataDir)).credentials.token}\n`))

  cli.command('bot keys set', 'Store OpenAI or Gemini API keys for voice transcription and kimaki tts')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--openai <key>', 'OpenAI API key')
    .option('--gemini <key>', 'Gemini API key')
    .action(async (options) => {
      const opened = await openCliDb(options.dataDir)
      const result = await (async () => {
        const credentials = await readSavedCredentials({ db: opened.db })
        if (credentials instanceof Error) return credentials
        if (!credentials) return new Error('No saved bot credentials. Start kimaki once to onboard.')
        return saveAudioKeys({ db: opened.db, token: credentials.token, openai: options.openai, gemini: options.gemini })
      })()
      opened.close()
      if (result instanceof Error) fail(result)
      process.stdout.write(`Saved ${[options.openai && 'OpenAI', options.gemini && 'Gemini'].filter(Boolean).join(' and ')} API key\n`)
    })

  cli.command('bot install-url', 'Print the Discord bot install URL')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--gateway-callback-url <url>', 'Gateway only: redirect here after the install')
    .action(async (options) => {
      const { credentials } = await discordApi(options.dataDir)
      process.stdout.write(`${installUrlFor({ credentials, website: gatewayUrlsFromEnv().website, callbackUrl: options.gatewayCallbackUrl })}\n`)
    })
}
