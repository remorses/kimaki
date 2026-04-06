// Scheduled task runner for executing due `send --send-at` jobs in the bot process.

import { type REST, Routes } from 'discord.js'
import { createDiscordRest } from './discord-urls.js'
import YAML from 'yaml'
import {
  claimScheduledTaskRunning,
  getDuePlannedScheduledTasks,
  markScheduledTaskCronRescheduled,
  markScheduledTaskCronRetry,
  markScheduledTaskFailed,
  markScheduledTaskOneShotCompleted,
  recoverStaleRunningScheduledTasks,
  type ScheduledTask,
} from './database.js'
import { createLogger, formatErrorWithStack, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'
import type { ThreadStartMarker } from './system-message.js'
import {
  type ScheduledTaskPayload,
  getNextCronRun,
  getPromptPreview,
  parseScheduledTaskPayload,
} from './task-schedule.js'

const taskLogger = createLogger(LogPrefix.TASK)

type StartTaskRunnerOptions = {
  token: string
  pollIntervalMs?: number
  staleRunningMs?: number
  dueBatchSize?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseMessageId(value: unknown): string | Error {
  if (!isRecord(value)) {
    return new Error('Discord response is not an object')
  }
  if (typeof value.id !== 'string') {
    return new Error('Discord response is missing message ID')
  }
  return value.id
}

async function executeThreadScheduledTask({
  rest,
  task,
  payload,
}: {
  rest: REST
  task: ScheduledTask
  payload: Extract<ScheduledTaskPayload, { kind: 'thread' }>
}): Promise<void | Error> {
  const marker: ThreadStartMarker = {
    start: true,
    scheduledKind: task.schedule_kind,
    scheduledTaskId: task.id,
    ...(payload.agent ? { agent: payload.agent } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.username ? { username: payload.username } : {}),
    ...(payload.userId ? { userId: payload.userId } : {}),
    ...(payload.permissions?.length ? { permissions: payload.permissions } : {}),
    ...(payload.injectionGuardPatterns?.length
      ? { injectionGuardPatterns: payload.injectionGuardPatterns }
      : {}),
  }
  const embed = [{ color: 0x2b2d31, footer: { text: YAML.stringify(marker) } }]
  // Newline between prefix and prompt so leading /command detection can
  // find the command on its own line.
  const prefixedPrompt = `» **kimaki-cli:**\n${payload.prompt}`

  const postResult = await rest
    .post(Routes.channelMessages(payload.threadId), {
      body: {
        content: prefixedPrompt,
        embeds: embed,
      },
    })
    .catch((error) => {
      return new Error(`Failed to post scheduled thread task ${task.id}`, {
        cause: error,
      })
    })

  if (postResult instanceof Error) {
    return postResult
  }
}

async function executeChannelScheduledTask({
  rest,
  task,
  payload,
}: {
  rest: REST
  task: ScheduledTask
  payload: Extract<ScheduledTaskPayload, { kind: 'channel' }>
}): Promise<void | Error> {
  const marker: ThreadStartMarker | undefined = payload.notifyOnly
    ? undefined
    : {
        start: true,
        scheduledKind: task.schedule_kind,
        scheduledTaskId: task.id,
        ...(payload.worktreeName ? { worktree: payload.worktreeName } : {}),
        ...(payload.cwd ? { cwd: payload.cwd } : {}),
        ...(payload.agent ? { agent: payload.agent } : {}),
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.username ? { username: payload.username } : {}),
        ...(payload.userId ? { userId: payload.userId } : {}),
        ...(payload.permissions?.length ? { permissions: payload.permissions } : {}),
        ...(payload.injectionGuardPatterns?.length
          ? { injectionGuardPatterns: payload.injectionGuardPatterns }
          : {}),
      }
  const embeds = marker
    ? [{ color: 0x2b2d31, footer: { text: YAML.stringify(marker) } }]
    : undefined

  const starterResult = await rest
    .post(Routes.channelMessages(payload.channelId), {
      body: {
        content: payload.prompt,
        embeds,
      },
    })
    .catch((error) => {
      return new Error(`Failed to create starter message for task ${task.id}`, {
        cause: error,
      })
    })

  if (starterResult instanceof Error) {
    return starterResult
  }

  const starterMessageId = parseMessageId(starterResult)
  if (starterMessageId instanceof Error) {
    return new Error(`Invalid starter message response for task ${task.id}`, {
      cause: starterMessageId,
    })
  }

  const threadName = (payload.name || getPromptPreview(payload.prompt)).slice(
    0,
    100,
  )
  const threadResult = await rest
    .post(Routes.threads(payload.channelId, starterMessageId), {
      body: {
        name: threadName,
        auto_archive_duration: 1440,
      },
    })
    .catch((error) => {
      return new Error(`Failed to create thread for task ${task.id}`, {
        cause: error,
      })
    })

  if (threadResult instanceof Error) {
    return threadResult
  }

  if (!payload.userId) {
    return
  }

  const threadIdResult = parseMessageId(threadResult)
  if (threadIdResult instanceof Error) {
    return new Error(`Invalid thread response for task ${task.id}`, {
      cause: threadIdResult,
    })
  }

  const addMemberResult = await rest
    .put(Routes.threadMembers(threadIdResult, payload.userId))
    .catch((error) => {
      return new Error(
        `Failed to add user to scheduled thread for task ${task.id}`,
        { cause: error },
      )
    })
  if (addMemberResult instanceof Error) {
    return addMemberResult
  }
}

async function executeScheduledTask({
  rest,
  task,
}: {
  rest: REST
  task: ScheduledTask
}): Promise<void | Error> {
  const payloadResult = parseScheduledTaskPayload(task.payload_json)
  if (payloadResult instanceof Error) {
    return new Error(`Task ${task.id} has invalid payload`, {
      cause: payloadResult,
    })
  }

  if (payloadResult.kind === 'thread') {
    return executeThreadScheduledTask({
      rest,
      task,
      payload: payloadResult,
    })
  }

  return executeChannelScheduledTask({
    rest,
    task,
    payload: payloadResult,
  })
}

async function finalizeSuccessfulTask({
  task,
  completedAt,
}: {
  task: ScheduledTask
  completedAt: Date
}): Promise<void> {
  if (task.schedule_kind === 'at') {
    await markScheduledTaskOneShotCompleted({ taskId: task.id, completedAt })
    return
  }

  if (!task.cron_expr) {
    await markScheduledTaskFailed({
      taskId: task.id,
      failedAt: completedAt,
      errorMessage: 'Missing cron expression on cron task',
    })
    return
  }

  // Use stored timezone, falling back to UTC (not machine local) for consistency
  const timezone = task.timezone || 'UTC'
  const nextRunResult = getNextCronRun({
    cronExpr: task.cron_expr,
    timezone,
    from: completedAt,
  })
  if (nextRunResult instanceof Error) {
    await markScheduledTaskFailed({
      taskId: task.id,
      failedAt: completedAt,
      errorMessage: nextRunResult.message,
    })
    return
  }

  await markScheduledTaskCronRescheduled({
    taskId: task.id,
    completedAt,
    nextRunAt: nextRunResult,
  })
}

async function finalizeFailedTask({
  task,
  failedAt,
  error,
}: {
  task: ScheduledTask
  failedAt: Date
  error: Error
}): Promise<void> {
  if (task.schedule_kind === 'cron' && task.cron_expr) {
    // Use stored timezone, falling back to UTC (not machine local) for consistency
    const timezone = task.timezone || 'UTC'
    const nextRunResult = getNextCronRun({
      cronExpr: task.cron_expr,
      timezone,
      from: failedAt,
    })
    if (!(nextRunResult instanceof Error)) {
      await markScheduledTaskCronRetry({
        taskId: task.id,
        failedAt,
        errorMessage: error.message,
        nextRunAt: nextRunResult,
      })
      return
    }
  }

  await markScheduledTaskFailed({
    taskId: task.id,
    failedAt,
    errorMessage: error.message,
  })
}

async function processDueTask({
  rest,
  task,
}: {
  rest: REST
  task: ScheduledTask
}): Promise<void> {
  const startedAt = new Date()
  const claimed = await claimScheduledTaskRunning({
    taskId: task.id,
    startedAt,
  })
  if (!claimed) {
    return
  }

  const executeResult = await executeScheduledTask({ rest, task })
  const finishedAt = new Date()

  if (executeResult instanceof Error) {
    taskLogger.warn(
      `[task-runner] task ${task.id} failed: ${formatErrorWithStack(executeResult)}`,
    )
    await finalizeFailedTask({
      task,
      failedAt: finishedAt,
      error: executeResult,
    })
    return
  }

  await finalizeSuccessfulTask({ task, completedAt: finishedAt })
}

async function runTaskRunnerTick({
  rest,
  staleRunningMs,
  dueBatchSize,
}: {
  rest: REST
  staleRunningMs: number
  dueBatchSize: number
}): Promise<void> {
  const staleBefore = new Date(Date.now() - staleRunningMs)
  const recoveredCount = await recoverStaleRunningScheduledTasks({
    staleBefore,
  })
  if (recoveredCount > 0) {
    taskLogger.warn(
      `[task-runner] Recovered ${recoveredCount} stale running task(s)`,
    )
  }

  const dueTasks = await getDuePlannedScheduledTasks({
    now: new Date(),
    limit: dueBatchSize,
  })

  await dueTasks.reduce<Promise<void>>(async (previous, task) => {
    await previous
    await processDueTask({ rest, task })
  }, Promise.resolve())
}

export function startTaskRunner({
  token,
  pollIntervalMs = 5_000,
  staleRunningMs = 120_000,
  dueBatchSize = 20,
}: StartTaskRunnerOptions): () => Promise<void> {
  const rest = createDiscordRest(token)
  let stopped = false
  let ticking = false
  let tickPromise: Promise<void> | null = null

  const tick = async () => {
    if (stopped || ticking) {
      return
    }

    ticking = true
    const currentTickPromise = runTaskRunnerTick({
      rest,
      staleRunningMs,
      dueBatchSize,
    }).catch((error) => {
      return new Error('Task runner tick failed', { cause: error })
    })
    tickPromise = currentTickPromise.then(() => {
      return
    })
    const runResult = await currentTickPromise
    if (runResult instanceof Error) {
      taskLogger.error(`[task-runner] ${formatErrorWithStack(runResult)}`)
      void notifyError(runResult, 'Task runner tick failed')
    }
    ticking = false
    tickPromise = null
  }

  const timer = setInterval(() => {
    void tick()
  }, pollIntervalMs)

  void tick()

  taskLogger.log(`[task-runner] started (interval=${pollIntervalMs}ms)`)

  return async () => {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(timer)
    if (tickPromise) {
      await tickPromise
      tickPromise = null
    }
    taskLogger.log('[task-runner] stopped')
  }
}
