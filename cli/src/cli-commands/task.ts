// Scheduled task management terminal commands.
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
  getDiscordUserIdFromUserOption,
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
  .command('task list', 'List scheduled tasks created via send --send-at')
  .option('--all', 'Include terminal tasks (completed, cancelled, failed)')
  .action(async (options: { all?: boolean }) => {
    try {
      await initDatabase()

      const statuses: Array<'planned' | 'running'> | undefined = options.all
        ? undefined
        : ['planned', 'running']
      const tasks = await listScheduledTasks({ statuses })
      if (tasks.length === 0) {
        cliLogger.log('No scheduled tasks found')
        process.exit(0)
      }

      console.log(
        'id | status | message | channelId | userId | projectName | folderName | agent | model | preRun | allowConcurrency | timeRemaining | firesAt | cron',
      )

      tasks.forEach((task) => {
        // Surfacing userId makes it obvious which tasks will never show up in
        // the user's Discord sidebar (no thread member is ever added for them).
        // agent/model live only in payload_json; list them so edits don't need SQLite.
        const payload = parseScheduledTaskPayload(task.payload_json)
        const userId = payload instanceof Error ? '?' : payload.userId || '-'
        const agent = payload instanceof Error ? '?' : payload.agent || '-'
        const model = payload instanceof Error ? '?' : payload.model || '-'
        const preRun = payload instanceof Error ? '?' : payload.preRunCommand || '-'
        const allowConcurrency = payload instanceof Error
          ? '?'
          : String(payload.allowConcurrency)
        const projectDirectory = task.project_directory || ''
        const projectName = projectDirectory
          ? path.basename(projectDirectory)
          : '-'
        const folderName = projectDirectory
          ? path.basename(path.dirname(projectDirectory))
          : '-'
        const firesAt =
          task.schedule_kind === 'at' && task.run_at
            ? task.run_at.toISOString()
            : '-'
        const cronValue =
          task.schedule_kind === 'cron' ? task.cron_expr || '-' : '-'

        console.log(
          `${task.id} | ${task.status} | ${task.prompt_preview} | ${task.channel_id || '-'} | ${userId} | ${projectName} | ${folderName} | ${agent} | ${model} | ${preRun} | ${allowConcurrency} | ${formatRelativeTime(task.next_run_at)} | ${firesAt} | ${cronValue}`,
        )
      })

      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command('task delete <id>', 'Cancel a scheduled task by ID')
  .action(async (id: string) => {
    try {
      const taskId = Number.parseInt(id, 10)
      if (Number.isNaN(taskId) || taskId < 1) {
        cliLogger.error(`Invalid task ID: ${id}`)
        process.exit(EXIT_NO_RESTART)
      }

      await initDatabase()
      const cancelled = await cancelScheduledTask(taskId)
      if (!cancelled) {
        cliLogger.error(`Task ${taskId} not found or already finalized`)
        process.exit(EXIT_NO_RESTART)
      }

      cliLogger.log(`Cancelled task ${taskId}`)
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

// Resolving a Discord user needs a guild only for username lookups. Raw IDs and
// mentions resolve offline, which keeps `task edit --user <id>` usable without
// a bot token or Server Members Intent.
async function resolveTaskUser({
  user,
  channelId,
}: {
  user: string
  channelId: string | null
}): Promise<{ id: string; username?: string } | Error> {
  const directUserId = getDiscordUserIdFromUserOption(user)
  if (directUserId) {
    return { id: directUserId }
  }

  if (!channelId) {
    return new Error(
      `Cannot look up username "${user}": task has no channel to resolve a guild from. Pass a Discord user ID instead.`,
    )
  }

  const { token } = await resolveBotCredentials()
  const rest = createDiscordRest(token)
  const channel = await rest
    .get(Routes.channel(channelId))
    .catch((error) => new Error('Failed to fetch task channel', { cause: error }))
  if (channel instanceof Error) return channel

  const guildId = (channel as { guild_id?: string }).guild_id
  if (!guildId) {
    return new Error(`Channel ${channelId} has no guild ID`)
  }

  const resolved = await resolveDiscordUserOption({ user, guildId, rest })
  if (resolved instanceof Error) return resolved
  if (!resolved) {
    return new Error(`Could not resolve user: ${user}`)
  }
  return resolved
}

cli
  .command(
    'task edit <id>',
    'Edit prompt, schedule, model, agent, or notified user of a planned task',
  )
  .option('--prompt <prompt>', 'New prompt text')
  .option('--send-at <sendAt>', 'New schedule (UTC ISO date or cron expression)')
  .option('--agent <agent>', 'Agent for the scheduled session (empty string clears)')
  .option(
    '--model <model>',
    'Model for the scheduled session, format provider/model (empty string clears)',
  )
  .option('--pre-run <command>', 'New pre-run command (empty string clears)')
  .option(
    '--allow-concurrency <enabled>',
    z.enum(['true', 'false']).describe('Allow concurrent sessions: true or false'),
  )
  .option(
    '-u, --user <user>',
    'Discord user ID, mention, or username added to the task thread',
  )
  .action(async (id, options) => {
    try {
      const trimmedPrompt =
        options.prompt === undefined ? undefined : options.prompt.trim()
      const hasAgent = options.agent !== undefined
      const hasModel = options.model !== undefined
      const hasPreRun = options.preRun !== undefined
      const hasAllowConcurrency = options.allowConcurrency !== undefined

      if (
        !trimmedPrompt &&
        !options.sendAt &&
        !options.user &&
        !hasAgent &&
        !hasModel &&
        !hasPreRun &&
        !hasAllowConcurrency
      ) {
        cliLogger.error(
          'Provide at least --prompt, --send-at, --user, --agent, --model, --pre-run or --allow-concurrency',
        )
        process.exit(EXIT_NO_RESTART)
      }
      if (trimmedPrompt !== undefined && trimmedPrompt.length === 0) {
        cliLogger.error('--prompt cannot be empty')
        process.exit(EXIT_NO_RESTART)
      }
      if (trimmedPrompt !== undefined && trimmedPrompt.length > 1900) {
        cliLogger.error('--prompt currently supports up to 1900 characters')
        process.exit(EXIT_NO_RESTART)
      }

      const taskId = Number.parseInt(id, 10)
      if (Number.isNaN(taskId) || taskId < 1) {
        cliLogger.error(`Invalid task ID: ${id}`)
        process.exit(EXIT_NO_RESTART)
      }

      await initDatabase()
      const task = await getScheduledTask(taskId)
      if (!task) {
        cliLogger.error(`Task ${taskId} not found`)
        process.exit(EXIT_NO_RESTART)
      }
      if (task.status !== 'planned') {
        cliLogger.error(
          `Task ${taskId} is ${task.status}, only planned tasks can be edited`,
        )
        process.exit(EXIT_NO_RESTART)
      }

      const existingPayload = parseScheduledTaskPayload(task.payload_json)
      if (existingPayload instanceof Error) {
        cliLogger.error(`Failed to parse task payload: ${existingPayload.message}`)
        process.exit(EXIT_NO_RESTART)
      }

      const resolvedUser = options.user
        ? await resolveTaskUser({
            user: options.user,
            channelId: task.channel_id,
          })
        : undefined
      if (resolvedUser instanceof Error) {
        cliLogger.error(resolvedUser.message)
        process.exit(EXIT_NO_RESTART)
      }

      const newPrompt = trimmedPrompt ?? existingPayload.prompt
      // Match send --model/--agent: empty string clears the override (null).
      const updatedPayload: ScheduledTaskPayload = {
        ...existingPayload,
        prompt: newPrompt,
        ...(resolvedUser
          ? { userId: resolvedUser.id, username: resolvedUser.username || null }
          : {}),
        ...(hasAgent ? { agent: options.agent!.trim() || null } : {}),
        ...(hasModel ? { model: options.model!.trim() || null } : {}),
        ...(hasPreRun ? { preRunCommand: options.preRun!.trim() || null } : {}),
        ...(hasAllowConcurrency
          ? { allowConcurrency: options.allowConcurrency === 'true' }
          : {}),
      }

      const updateData: Parameters<typeof updateScheduledTask>[0] = {
        taskId,
        payloadJson: serializeScheduledTaskPayload(updatedPayload),
        promptPreview: getPromptPreview(newPrompt),
      }

      if (options.sendAt) {
        // Same as send: cron is always UTC so schedule does not depend on host TZ.
        const parsed = parseSendAtValue({
          value: options.sendAt,
          now: new Date(),
          timezone: 'UTC',
        })
        if (parsed instanceof Error) {
          cliLogger.error(`Invalid --send-at: ${parsed.message}`)
          process.exit(EXIT_NO_RESTART)
        }
        updateData.scheduleKind = parsed.scheduleKind
        updateData.runAt = parsed.runAt
        updateData.cronExpr = parsed.cronExpr
        updateData.timezone = parsed.timezone
        updateData.nextRunAt = parsed.nextRunAt
      }

      const updated = await updateScheduledTask(updateData)
      if (!updated) {
        cliLogger.error(`Task ${taskId} could not be updated (status may have changed)`)
        process.exit(EXIT_NO_RESTART)
      }

      const parts: string[] = [`Updated task ${taskId}`]
      if (resolvedUser) {
        parts.push(
          `user ${resolvedUser.username || resolvedUser.id} will be added to the thread`,
        )
      }
      if (hasAgent) {
        parts.push(`agent=${updatedPayload.agent || '-'}`)
      }
      if (hasModel) {
        parts.push(`model=${updatedPayload.model || '-'}`)
      }
      if (hasPreRun) parts.push(`preRun=${updatedPayload.preRunCommand || '-'}`)
      if (hasAllowConcurrency) {
        parts.push(`allowConcurrency=${updatedPayload.allowConcurrency}`)
      }
      cliLogger.log(parts.join(' | '))
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })


export default cli
