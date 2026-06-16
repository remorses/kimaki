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
        'id | status | message | channelId | projectName | folderName | timeRemaining | firesAt | cron',
      )

      tasks.forEach((task) => {
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
          `${task.id} | ${task.status} | ${task.prompt_preview} | ${task.channel_id || '-'} | ${projectName} | ${folderName} | ${formatRelativeTime(task.next_run_at)} | ${firesAt} | ${cronValue}`,
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

cli
  .command('task edit <id>', 'Edit prompt or schedule of a planned task')
  .option('--prompt <prompt>', 'New prompt text')
  .option('--send-at <sendAt>', 'New schedule (UTC ISO date or cron expression)')
  .action(async (id: string, options: { prompt?: string; sendAt?: string }) => {
    try {
      const trimmedPrompt =
        options.prompt === undefined ? undefined : options.prompt.trim()

      if (!trimmedPrompt && !options.sendAt) {
        cliLogger.error('Provide at least --prompt or --send-at')
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

      const newPrompt = trimmedPrompt ?? existingPayload.prompt
      const updatedPayload: ScheduledTaskPayload = {
        ...existingPayload,
        prompt: newPrompt,
      }

      const updateData: Parameters<typeof updateScheduledTask>[0] = {
        taskId,
        payloadJson: serializeScheduledTaskPayload(updatedPayload),
        promptPreview: getPromptPreview(newPrompt),
      }

      if (options.sendAt) {
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

      cliLogger.log(`Updated task ${taskId}`)
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
