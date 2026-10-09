// Bot lifecycle and setup: the root command (start + onboarding), provider
// login, tools (tunnel, tts), and bot status, logs, credentials and keys.
// main.ts, onboarding.ts, traforo, SQLite and voice are loaded only by the
// commands that run them (see the note in shared.ts).

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import dedent from 'string-dedent'
import type { Goke } from 'goke'

import { callBot, DEFAULT_LOCK_PORT, RESTART_EXIT_CODE, startLockServer } from '../lock-server.ts'
import { parseDuration } from '../duration.ts'
import { createLogger, setLogFile } from '../logger.ts'
import { action, DATA_DIR_HELP, dataDirOrDefault, discordApi, fail, openCliDb, printJson } from './shared.ts'

const logger = createLogger('CLI')

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

// The root command runs the bot in a child process and starts it again when it
// exits with RESTART_EXIT_CODE (`kimaki restart`), so a restart loads new code:
//
//   kimaki (supervisor) ──spawn, same argv, KIMAKI_SUPERVISED=1──▶ bot
//        ▲                                                         │
//        └──────────── exit 75: spawn again; other code: exit ─────┘
//
// The child shares the terminal (stdio inherit), so onboarding prompts work.
// The IPC channel only exists so the child sees `disconnect` if the supervisor dies.
async function supervise(): Promise<never> {
  const state: { child: ChildProcess | null } = { child: null }
  // Ctrl+C reaches both processes; `kill <supervisor pid>` reaches only this one.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => state.child?.kill('SIGTERM'))
  }
  while (true) {
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, KIMAKI_SUPERVISED: '1' },
    })
    state.child = child
    const code = await new Promise<number>((resolve) => {
      child.once('error', (error) => {
        process.stderr.write(`Cannot start the kimaki bot process: ${error.message}\n`)
        resolve(1)
      })
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
    })
    if (code !== RESTART_EXIT_CODE) process.exit(code)
    process.stderr.write('Restarting kimaki...\n')
  }
}

// `kimaki` with no subcommand.
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
      // The IPC check ignores a KIMAKI_SUPERVISED leaked into a shell by an older bot.
      if (process.env['KIMAKI_SUPERVISED'] !== '1' || !process.connected) return supervise()
      // OpenCode and agent shells inherit process.env: a bot started from a
      // session (tests) would otherwise think it is supervised and SIGTERM itself on restart.
      delete process.env['KIMAKI_SUPERVISED']
      // Bot code loads only here: the other subcommands start without it.
      const [
        { startBot },
        { ensureOpencode, kimakiShellCommand, runOnboarding, startCaffeinate },
        { emitEvent, gatewayCredentials, gatewayUrlsFromEnv, installUrlFor, readSavedCredentials, resolveCredentials, restApiUrl },
        { openDb },
        { createAnalytics },
        { opencodeConfigDir },
        { defaultMachineName },
      ] = await Promise.all([
        import('../main.ts'),
        import('../onboarding.ts'),
        import('../credentials.ts'),
        import('../db.ts'),
        import('../analytics.ts'),
        import('../opencode-server.ts'),
        import('../project.ts'),
      ])
      // Non-TTY hosts get the failure as an `error` event too (programmatic onboarding).
      // Explicit type: TS narrows after a `never` call only for annotated consts.
      const failStartup: (error: Error, installUrl?: string) => never = (error, installUrl) => {
        if (!process.stdin.isTTY) emitEvent({ type: 'error', message: error.message, ...(installUrl && { install_url: installUrl }) })
        fail(error)
      }
      const dataDir = dataDirOrDefault(options.dataDir)
      const urls = gatewayUrlsFromEnv()
      const machine = options.machineName ?? defaultMachineName()

      if (options.installUrl) {
        const opened = await openDb({ dataDir, migrate: true })
        if (opened instanceof Error) fail(opened)
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

      // Creates the data dir, so the eviction, import and onboarding logs land in kimaki.log.
      const logFile = setLogFile({ dataDir })
      if (logFile instanceof Error) failStartup(logFile)
      // A crash goes to kimaki.log too (Node still prints it and exits).
      process.on('uncaughtExceptionMonitor', (error, origin) => logger.error(`crash (${origin})`, error))
      // Then: stops a running bot of this port (V1 or V2) before the
      // migration and onboarding, which must not run while it still writes.
      const lock = await startLockServer({ port: Number(process.env['KIMAKI_LOCK_PORT'] || DEFAULT_LOCK_PORT), dataDir, supervised: true })
      if (lock instanceof Error) failStartup(lock)
      const opened = await openDb({ dataDir, migrate: true })
      if (opened instanceof Error) failStartup(opened)

      // Before onboarding: without OpenCode the bot cannot start, so fail (or install it) before the Discord install.
      const opencodeCheck = await ensureOpencode({ serviceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'] })
      if (opencodeCheck instanceof Error) {
        opened.close()
        failStartup(opencodeCheck)
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
        command: [process.execPath, ...process.execArgv, process.argv[1] ?? 'kimaki'],
        dataDir,
      })

      const bot = await startBot({
        kimakiCommand: kimaki,
        dataDir,
        token: credentials.token,
        appId: credentials.appId,
        discordRestUrl: restApiUrl(credentials),
        lock,
        opencodeServiceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'],
        ensureOpencode: true,
        opencodeConfigDir: opencodeConfigDir(),
        analytics: createAnalytics({ dataDir, botMode: credentials.mode, enabled: !options.noAnalytics }),
        autoWorktrees: Boolean(options.worktrees),
      })
      if (bot instanceof Error) failStartup(bot)
      // exit() keeps process.exitCode: the restart route sets RESTART_EXIT_CODE before its SIGTERM.
      const shutdown = () => {
        void bot.stop().then(() => process.exit())
      }
      process.once('SIGTERM', shutdown)
      process.once('SIGINT', shutdown)
      // The supervisor died (SIGKILL, crash): nobody owns this bot anymore.
      process.once('disconnect', shutdown)

      const gateway = credentials.mode === 'gateway'
      const onboarded = await runOnboarding({ bot, dataDir, guildId: options.guild ?? install?.guildId, installUrl, kimaki, gateway, installerId: install?.installerId, machine })
      // The bot keeps running; the next start retries onboarding.
      if (onboarded instanceof Error) {
        logger.error(`onboarding failed`, onboarded)
        if (!process.stdin.isTTY) emitEvent({ type: 'error', message: `Onboarding failed: ${onboarded.message}. The bot is running; restart kimaki to retry.` })
        return
      }
      if (onboarded) process.stderr.write(`Onboarding thread: https://discord.com/channels/${onboarded.guildId}/${onboarded.threadId}\n`)
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
      const [{ openDb }, { audioKeyCandidates, generateSpeech }] = await Promise.all([import('../db.ts'), import('../voice.ts')])
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

  cli.command('restart', 'Restart the running bot with the code on disk. Sessions keep running in OpenCode')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => {
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'restart', input: {} })
      if (result instanceof Error) fail(result)
      process.stdout.write(`Restarting bot (pid ${result.data.pid})\n`)
    })

  cli.command('profile cpu', 'Record a CPU profile of the running bot and print the .cpuprofile path')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-d, --duration <duration>', 'How long to record, e.g. 20s or 2m (default: 20s)')
    .example('kimaki profile cpu --duration 30s')
    .action(async (options) => {
      const durationMs = parseDuration(options.duration ?? '20s', '--duration')
      if (durationMs instanceof Error) fail(durationMs)
      // Ctrl+C stops the recording early; the bot still writes the profile.
      const controller = new AbortController()
      process.once('SIGINT', () => controller.abort())
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(durationMs + 30_000)])
      process.stderr.write(`Recording for ${options.duration ?? '20s'}. Press Ctrl+C to stop early.\n`)
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'profile.cpu', input: { durationMs }, signal })
      if (result instanceof Error) fail(controller.signal.aborted ? new Error('Stopped early. The bot writes the profile to <data dir>/profiles/') : result)
      process.stdout.write(`${result.data.path}\n`)
    })

  cli.command('profile heap', 'Write a heap snapshot of the running bot and print the .heapsnapshot path')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => {
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'profile.heap', input: {}, signal: AbortSignal.timeout(300_000) })
      if (result instanceof Error) fail(result)
      process.stdout.write(`${result.data.path}\n`)
    })

  cli.command('bot token', 'Print saved bot credentials for automation')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => process.stdout.write(`${(await discordApi(options.dataDir)).credentials.token}\n`))

  cli.command('bot keys set', 'Store OpenAI or Gemini API keys for voice transcription and kimaki tts')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--openai <key>', 'OpenAI API key')
    .option('--gemini <key>', 'Gemini API key')
    .action(async (options) => {
      const [{ readSavedCredentials }, { saveAudioKeys }] = await Promise.all([import('../credentials.ts'), import('../voice.ts')])
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
      const { installUrlFor, gatewayUrlsFromEnv } = await import('../credentials.ts')
      const { credentials } = await discordApi(options.dataDir)
      process.stdout.write(`${installUrlFor({ credentials, website: gatewayUrlsFromEnv().website, callbackUrl: options.gatewayCallbackUrl })}\n`)
    })
}
