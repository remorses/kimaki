#!/usr/bin/env node
// Main CLI entrypoint for the Kimaki Discord bot.
// Handles interactive setup, Discord OAuth, slash command registration,
// project channel creation, and launching the bot with opencode integration.
import { goke } from 'goke'
import { z } from 'zod'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createLogger, formatErrorWithStack, initLogFile, LogPrefix } from './logger.js'
import { initSentry } from './sentry.js'
import { setDataDir, setProjectsDir, getDataDir, getProjectsDir } from './config.js'
import { getCurrentVersion } from './upgrade.js'
import { store } from './store.js'
import multioauthCommands from './commands/multioauth.js'
import botCommands from './cli-commands/bot.js'
import maintenanceCommands from './cli-commands/maintenance.js'
import miscCommands from './cli-commands/misc.js'
import projectCommands from './cli-commands/project.js'
import sendCommands from './cli-commands/send.js'
import sessionCommands from './cli-commands/session.js'
import taskCommands from './cli-commands/task.js'
import userCommands from './cli-commands/user.js'
import { EXIT_NO_RESTART, printDiscordInstallUrlAndExit, run } from './cli-runner.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke('kimaki')
cli.use(multioauthCommands)

process.title = 'kimaki'

cli
  .command('', 'Set up and run the Kimaki Discord bot')
  .option('--restart-onboarding', 'Prompt for new credentials even if saved')
  .option('--add-channels', 'Select OpenCode projects to create Discord channels before starting')
  .option('--data-dir <path>', 'Data directory for config and database (default: ~/.kimaki)')
  .option(
    '--projects-dir <path>',
    'Directory where new projects are created (default: <data-dir>/projects)',
  )
  .option('--install-url', 'Print the bot install URL and exit')
  .option(
    '--use-worktrees',
    'Create git worktrees for all new sessions started from channel messages',
  )
  .option('--enable-voice-channels', 'Create voice channels for projects (disabled by default)')
  .option(
    '--verbosity <level>',
    'Default verbosity for all channels (tools_and_text, text_and_essential_tools, or text_only)',
  )
  .option('--mention-mode', 'Bot only responds when @mentioned (default for all channels)')
  .option('--no-critique', 'Disable automatic diff upload to critique.work in system prompts')
  .option('--auto-restart', 'Automatically restart the bot on crash or OOM kill')
  .option(
    '--allow-all-users',
    'Allow all Discord users to start sessions without needing Kimaki role or admin permissions (no-kimaki role still blocks)',
  )
  .option(
    '--permission-timeout-minutes <minutes>',
    'Permission prompt timeout in minutes before auto-rejecting (default: 10)',
  )
  .option('--disable-sync', 'Disable background sync of external OpenCode sessions into Discord')
  .option('--no-sentry', 'Disable Sentry error reporting')
  .option(
    '--gateway',
    'Force gateway mode (use the gateway Kimaki bot instead of a self-hosted bot)',
  )
  .option(
    '--gateway-callback-url <url>',
    'After gateway OAuth install, redirect to this URL instead of the default success page (appends ?guild_id=<id>)',
  )
  .option(
    '--allow-mention <type>',
    z
      .array(z.enum(['users', 'roles', 'everyone']))
      .optional()
      .describe(
        'Which mention types the bot can trigger (users, roles, everyone). Repeatable. Default: users only.',
      ),
  )
  .option(
    '--enable-skill <name>',
    z
      .array(z.string())
      .optional()
      .describe(
        'Whitelist a built-in skill by name. Only the listed skills are injected into the model (all others are hidden via an opencode permission.skill deny-all rule). Repeatable: pass --enable-skill multiple times. Mutually exclusive with --disable-skill. See https://github.com/remorses/kimaki/tree/main/skills for available skills.',
      ),
  )
  .option(
    '--disable-skill <name>',
    z
      .array(z.string())
      .optional()
      .describe(
        'Blacklist a built-in skill by name. Listed skills are hidden from the model. Repeatable: pass --disable-skill multiple times. Mutually exclusive with --enable-skill. See https://github.com/remorses/kimaki/tree/main/skills for available skills.',
      ),
  )
  .action(
    async (options: {
      restartOnboarding?: boolean
      addChannels?: boolean
      dataDir?: string
      projectsDir?: string
      installUrl?: boolean
      useWorktrees?: boolean
      enableVoiceChannels?: boolean
      verbosity?: string
      mentionMode?: boolean
      noCritique?: boolean
      allowAllUsers?: boolean
      permissionTimeoutMinutes?: string
      disableSync?: boolean
      autoRestart?: boolean
      noSentry?: boolean
      gateway?: boolean
      gatewayCallbackUrl?: string
      allowMention?: Array<'users' | 'roles' | 'everyone'>
      enableSkill?: string[]
      disableSkill?: string[]
    }) => {
      // Guard: only one kimaki bot process can run per lock port. Agents may run
      // a second dev bot only when they explicitly choose a different lock port.
      const parentLockPort = process.env.KIMAKI_PARENT_LOCK_PORT
      const currentLockPort = process.env.KIMAKI_LOCK_PORT
      const usesDifferentLockPort = currentLockPort !== parentLockPort

      if (process.env.KIMAKI_OPENCODE_PROCESS && !usesDifferentLockPort) {
        cliLogger.error(
          'Cannot run `kimaki` inside an OpenCode session — it would kill the already-running bot process.\n' +
            'Only one kimaki bot can run at a time (they share a lock port).\n' +
            'Set KIMAKI_LOCK_PORT to a different port for an isolated dev process, or use `kimaki send`, `kimaki session`, and other subcommands instead.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      if (process.env.KIMAKI_OPENCODE_PROCESS && usesDifferentLockPort) {
        delete process.env['KIMAKI_DB_URL']
        delete process.env['KIMAKI_DB_AUTH_TOKEN']
      }

      try {
        // Set data directory early, before any database access
        if (options.dataDir) {
          setDataDir(options.dataDir)
          cliLogger.log(`Using data directory: ${getDataDir()}`)
        }

        if (options.projectsDir) {
          setProjectsDir(options.projectsDir)
          cliLogger.log(`Using projects directory: ${getProjectsDir()}`)
        }

        // Initialize file logging to <dataDir>/kimaki.log
        initLogFile(getDataDir())

        // Batch all CLI flag store updates into a single setState call.
        const defaultVerbosity = (() => {
          if (!options.verbosity) {
            return undefined
          }
          if (options.verbosity === 'tools_and_text') {
            return 'tools_and_text'
          }
          if (options.verbosity === 'text_and_essential_tools') {
            return 'text_and_essential_tools'
          }
          if (options.verbosity === 'text_only') {
            return 'text_only'
          }
          cliLogger.error(
            `Invalid verbosity level: ${options.verbosity}. Use one of: tools_and_text, text_and_essential_tools, text_only`,
          )
          process.exit(EXIT_NO_RESTART)
        })()

        // --enable-skill and --disable-skill are mutually exclusive: the user
        // either whitelists a small allowlist or blacklists a few unwanted
        // skills, never both. Applied later in opencode.ts as permission.skill
        // rules via computeSkillPermission().
        const enabledSkills = options.enableSkill ?? []
        const disabledSkills = options.disableSkill ?? []
        if (enabledSkills.length > 0 && disabledSkills.length > 0) {
          cliLogger.error(
            'Cannot use --enable-skill and --disable-skill at the same time. Use one or the other.',
          )
          process.exit(EXIT_NO_RESTART)
        }
        // Soft-validate skill names against the bundled skills/ folder. Users
        // may rely on skills loaded from their own .opencode / .claude / .agents
        // dirs, so unknown names only emit a warning rather than hard-failing.
        if (enabledSkills.length > 0 || disabledSkills.length > 0) {
          const bundledSkillsDir = path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '..',
            'skills',
          )
          const availableBundledSkills: string[] = (() => {
            try {
              return fs
                .readdirSync(bundledSkillsDir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
            } catch {
              return []
            }
          })()
          const availableSet = new Set(availableBundledSkills)
          for (const name of [...enabledSkills, ...disabledSkills]) {
            if (!availableSet.has(name)) {
              cliLogger.warn(
                `Skill "${name}" is not a bundled kimaki skill. Rule will still apply (user-provided skills from .opencode/.claude/.agents dirs may match). Available bundled skills: ${availableBundledSkills.join(', ')}`,
              )
            }
          }
        }

        // --permission-timeout-minutes validation
        const permissionTimeoutMs = (() => {
          if (!options.permissionTimeoutMinutes) {
            return undefined
          }
          const parsed = Number.parseInt(options.permissionTimeoutMinutes, 10)
          if (!Number.isFinite(parsed) || parsed <= 0) {
            cliLogger.error(
              `Invalid permission timeout: ${options.permissionTimeoutMinutes}. Must be a positive number of minutes.`,
            )
            process.exit(EXIT_NO_RESTART)
          }
          return parsed * 60 * 1000
        })()

        store.setState({
          ...(defaultVerbosity && {
            defaultVerbosity,
          }),
          ...(options.mentionMode && { defaultMentionMode: true }),
          ...(options.noCritique && { critiqueEnabled: false }),
          ...(options.allowAllUsers && { allowAllUsers: true }),
          ...(permissionTimeoutMs !== undefined && { permissionTimeoutMs }),
          ...(options.disableSync && { syncEnabled: false }),
          ...(enabledSkills.length > 0 && { enabledSkills }),
          ...(disabledSkills.length > 0 && { disabledSkills }),
          ...(options.allowMention && { allowedMentions: options.allowMention }),
        })

        if (enabledSkills.length > 0) {
          cliLogger.log(
            `Skill whitelist enabled: only [${enabledSkills.join(', ')}] will be injected`,
          )
        }
        if (disabledSkills.length > 0) {
          cliLogger.log(`Skill blacklist enabled: [${disabledSkills.join(', ')}] will be hidden`)
        }

        if (options.allowAllUsers) {
          cliLogger.log(
            'Allow all users: any Discord member can start sessions (no-kimaki role still blocks)',
          )
        }

        if (permissionTimeoutMs !== undefined) {
          cliLogger.log(`Permission timeout set to ${options.permissionTimeoutMinutes} minutes`)
        }

        if (options.verbosity) {
          cliLogger.log(`Default verbosity: ${options.verbosity}`)
        }
        if (options.mentionMode) {
          cliLogger.log('Default mention mode: enabled (bot only responds when @mentioned)')
        }
        if (options.noCritique) {
          cliLogger.log('Critique disabled: diffs will not be auto-uploaded to critique.work')
        }
        if (options.disableSync) {
          cliLogger.log(
            'Background sync disabled: external OpenCode sessions will not appear in Discord',
          )
        }
        if (options.noSentry) {
          process.env.KIMAKI_SENTRY_DISABLED = '1'
          cliLogger.log('Sentry error reporting disabled (--no-sentry)')
        } else {
          initSentry()
        }

        if (options.installUrl) {
          await printDiscordInstallUrlAndExit({
            gateway: options.gateway,
            gatewayCallbackUrl: options.gatewayCallbackUrl,
          })
        }

        // Single-instance enforcement is handled by the hrana server binding the lock port.
        // startHranaServer() in run() evicts any existing instance before binding.
        await run({
          restartOnboarding: options.restartOnboarding,
          addChannels: options.addChannels,
          dataDir: options.dataDir,
          useWorktrees: options.useWorktrees,
          enableVoiceChannels: options.enableVoiceChannels,
          gateway: options.gateway,
          gatewayCallbackUrl: options.gatewayCallbackUrl,
        })
      } catch (error) {
        cliLogger.error('Unhandled error:', formatErrorWithStack(error))
        process.exit(EXIT_NO_RESTART)
      }
    },
  )

cli.use(botCommands)
cli.use(miscCommands)
cli.use(sendCommands)
cli.use(taskCommands)
cli.use(projectCommands)
cli.use(userCommands)
cli.use(sessionCommands)
cli.use(maintenanceCommands)

cli.version(getCurrentVersion())
cli.help()
void cli.parse()
