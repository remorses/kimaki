// Upgrade and worktree maintenance terminal commands.
import { goke } from 'goke'
import { z } from 'zod'
import { note } from '@clack/prompts'
import YAML from 'yaml'
import * as errore from 'errore'
import type { OpencodeClient, Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { Events, ActivityType, type PresenceStatusData, type Guild, Routes } from 'discord.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { createLogger, LogPrefix, initLogFile } from '../logger.js'
import { createDiscordClient, initDatabase, getChannelDirectory, initializeOpencodeForDirectory, createProjectChannels } from '../discord-bot.js'
import { getBotTokenWithMode, getThreadSession, getThreadIdBySessionId, getSessionEventSnapshot, createScheduledTask, listScheduledTasks, cancelScheduledTask, getScheduledTask, updateScheduledTask, getSessionStartSourcesBySessionIds, deleteChannelDirectoryById, findChannelsByDirectory } from '../database.js'
import { ShareMarkdown } from '../markdown.js'
import { parseSessionSearchPattern, findFirstSessionSearchHit, buildSessionSearchSnippet, getPartSearchTexts } from '../session-search.js'
import { formatWorktreeName, formatAutoWorktreeName } from '../commands/new-worktree.js'
import { WORKTREE_PREFIX } from '../commands/merge-worktree.js'
import type { ThreadStartMarker } from '../system-message.js'
import { buildOpencodeEventLogLine } from '../session-handler/opencode-session-event-log.js'
import { createDiscordRest } from '../discord-urls.js'
import { archiveThread, uploadFilesToDiscord, stripMentions } from '../discord-utils.js'
import { setDataDir, setProjectsDir, getDataDir, getProjectsDir } from '../config.js'
import { execAsync, validateWorktreeDirectory } from '../worktrees.js'
import { upgrade, getCurrentVersion } from '../upgrade.js'
import { getPromptPreview, parseSendAtValue, parseScheduledTaskPayload, serializeScheduledTaskPayload, type ScheduledTaskPayload } from '../task-schedule.js'
import {
  EXIT_NO_RESTART,
  formatMemberLookupUnavailableMessage,
  formatRelativeTime,
  formatTaskScheduleLine,
  isDiscordMemberLookupUnavailable,
  isGuildMemberSearchResult,
  isThreadChannelType,
  printDiscordInstallUrlAndExit,
  resolveBotCredentials,
  resolveDiscordUserOption,
  sendDiscordMessageWithOptionalAttachment,
} from '../cli-runner.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

cli
  .command(
    'upgrade',
    'Upgrade kimaki to the latest version and restart the running bot',
  )
  .option('--skip-restart', 'Only upgrade, do not restart the running bot')
  .action(async (options) => {
    try {
      const current = getCurrentVersion()
      cliLogger.log(`Current version: v${current}`)

      const newVersion = await upgrade()
      if (!newVersion) {
        cliLogger.log('Already on latest version')
        process.exit(0)
      }

      cliLogger.log(`Upgraded to v${newVersion}`)

      if (options.skipRestart) {
        process.exit(0)
      }

      // Spawn a new kimaki process without args (starts the bot with default command).
      // The new process kills the old one via the single-instance lock.
      // No args passed to avoid recursively running `upgrade` again.
      const child = spawn('kimaki', [], {
        shell: true,
        stdio: 'ignore',
        detached: true,
      })
      child.unref()
      cliLogger.log('Restarting bot with new version...')
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Upgrade failed:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'worktree merge',
    'Merge worktree branch into default branch using worktrunk-style pipeline',
  )
  .option('-d, --directory <path>', 'Worktree directory (defaults to cwd)')
  .option(
    '-m, --main-repo <path>',
    'Main repository directory (auto-detected from worktree)',
  )
  .option(
    '-n, --name <name>',
    'Worktree/branch name (auto-detected from branch)',
  )
  .action(
    async (options: {
      directory?: string
      mainRepo?: string
      name?: string
    }) => {
      try {
        const { mergeWorktree } = await import('../worktrees.js')
        const worktreeDir = path.resolve(options.directory || '.')

        // Auto-detect main repo: find the main worktree's toplevel.
        // For linked worktrees, --git-common-dir points to the shared .git,
        // and the main worktree's toplevel is one level up from that (non-bare)
        // or the dir itself (bare). We use git's worktree list to get the
        // main worktree path reliably.
        let mainRepoDir = options.mainRepo
        if (!mainRepoDir) {
          try {
            // `git worktree list --porcelain` first line is always the main worktree
            const { stdout } = await execAsync(
              `git -C "${worktreeDir}" worktree list --porcelain`,
            )
            const firstLine = stdout.split('\n')[0] || ''
            // Format: "worktree /path/to/main"
            mainRepoDir = firstLine.replace(/^worktree\s+/, '').trim()
          } catch {
            // Fallback: derive from git common dir
            const { stdout: commonDir } = await execAsync(
              `git -C "${worktreeDir}" rev-parse --git-common-dir`,
            )
            const resolved = path.isAbsolute(commonDir.trim())
              ? commonDir.trim()
              : path.resolve(worktreeDir, commonDir.trim())
            mainRepoDir = path.dirname(resolved)
          }
        }

        // Auto-detect branch name if not provided
        let worktreeName = options.name
        if (!worktreeName) {
          try {
            const { stdout } = await execAsync(
              `git -C "${worktreeDir}" symbolic-ref --short HEAD`,
            )
            worktreeName = stdout.trim()
          } catch {
            worktreeName = path.basename(worktreeDir)
          }
        }

        cliLogger.log(`Worktree: ${worktreeDir}`)
        cliLogger.log(`Main repo: ${mainRepoDir}`)
        cliLogger.log(`Branch: ${worktreeName}`)

        const { RebaseConflictError } = await import('../errors.js')

        const result = await mergeWorktree({
          worktreeDir,
          mainRepoDir,
          worktreeName,
          onProgress: (msg) => {
            cliLogger.log(msg)
          },
        })

        if (result instanceof Error) {
          cliLogger.error(`Merge failed: ${result.message}`)
          if (result instanceof RebaseConflictError) {
            cliLogger.log(
              'Resolve the rebase conflicts, then run this command again.',
            )
          }
          process.exit(1)
        }

        cliLogger.log(
          `Merged ${result.branchName} into ${result.defaultBranch} @ ${result.shortSha} (${result.commitCount} commit${result.commitCount === 1 ? '' : 's'})`,
        )
        process.exit(0)
      } catch (error) {
        cliLogger.error(
          'Merge failed:',
          error instanceof Error ? error.stack : String(error),
        )
        process.exit(EXIT_NO_RESTART)
      }
    },
  )

export default cli
