// Scheduled task runner for executing due `send --send-at` jobs in the bot process.

import yaml from 'js-yaml'
import * as errore from 'errore'
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
  getLocalTimeZone,
  getNextCronRun,
  getPromptPreview,
  parseScheduledTaskPayload,
} from './task-schedule.js'
import type { KimakiAdapter } from './platform/types.js'

const taskLogger = createLogger(LogPrefix.TASK)

type StartTaskRunnerOptions = {
  adapter: KimakiAdapter
  pollIntervalMs?: number
  staleRunningMs?: number
  dueBatchSize?: number
}

async function executeThreadScheduledTask({
  adapter,
  task,
  payload,
}: {
  adapter: KimakiAdapter
  task: ScheduledTask
  payload: {
    threadId: string
    prompt: string
    agent: string | null
    model: string | null
    username: string | null
    userId: string | null
  }
}): Promise<void | Error> {
  const marker: ThreadStartMarker = {
    cliThreadPrompt: true,
    scheduledKind: task.schedule_kind,
    scheduledTaskId: task.id,
    ...(payload.agent ? { agent: payload.agent } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.username ? { username: payload.username } : {}),
    ...(payload.userId ? { userId: payload.userId } : {}),
  }
  const embed = [{ color: 0x2b2d31, footer: { text: yaml.dump(marker) } }]
  const prefixedPrompt = `» **kimaki-cli:** ${payload.prompt}`

  const postResult = await errore.tryAsync({
    try: async () => {
      await adapter.conversation({ channelId: payload.threadId }).send({
        markdown: prefixedPrompt,
        embeds: embed,
      })
    },
    catch: (error) => {
      return new Error(`Failed to post scheduled thread task ${task.id}`, {
        cause: error,
      })
    },
  })

  if (postResult instanceof Error) {
    return postResult
  }
}

async function executeChannelScheduledTask({
  adapter,
  task,
  payload,
}: {
  adapter: KimakiAdapter
  task: ScheduledTask
  payload: {
    channelId: string
    prompt: string
    name: string | null
    notifyOnly: boolean
    worktreeName: string | null
    agent: string | null
    model: string | null
    username: string | null
    userId: string | null
  }
}): Promise<void | Error> {
  const marker: ThreadStartMarker | undefined = payload.notifyOnly
    ? undefined
    : {
        start: true,
        scheduledKind: task.schedule_kind,
        scheduledTaskId: task.id,
        ...(payload.worktreeName ? { worktree: payload.worktreeName } : {}),
        ...(payload.agent ? { agent: payload.agent } : {}),
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.username ? { username: payload.username } : {}),
        ...(payload.userId ? { userId: payload.userId } : {}),
      }
  const embeds = marker
    ? [{ color: 0x2b2d31, footer: { text: yaml.dump(marker) } }]
    : undefined

  const starterResult = await errore.tryAsync({
    try: async () => {
      return adapter.conversation({ channelId: payload.channelId }).send({
        markdown: payload.prompt,
        embeds,
      })
    },
    catch: (error) => {
      return new Error(`Failed to create starter message for task ${task.id}`, {
        cause: error,
      })
    },
  })

  if (starterResult instanceof Error) {
    return starterResult
  }

  const threadName = (payload.name || getPromptPreview(payload.prompt)).slice(
    0,
    100,
  )
  const threadResult = await errore.tryAsync({
    try: async () => {
      const conversation = adapter.conversation({ channelId: payload.channelId })
      const starterMessage = await conversation.message(starterResult.id)
      return starterMessage.startThread({
        name: threadName,
        autoArchiveDuration: 1440,
        reason: `Scheduled task ${task.id}`,
      })
    },
    catch: (error) => {
      return new Error(`Failed to create thread for task ${task.id}`, {
        cause: error,
      })
    },
  })

  if (threadResult instanceof Error) {
    return threadResult
  }

  if (!payload.userId) {
    return
  }
  const userId = payload.userId

  const addMemberResult = await errore.tryAsync({
    try: async () => {
      const threadHandle = await adapter.thread({
        threadId: threadResult.target.threadId,
        parentId: payload.channelId,
      })
      if (!threadHandle) {
        throw new Error(
          `Thread not found after creation for task ${task.id}: ${threadResult.target.threadId}`,
        )
      }
      await threadHandle.addMember(userId)
    },
    catch: (error) => {
      return new Error(
        `Failed to add user to scheduled thread for task ${task.id}`,
        { cause: error },
      )
    },
  })
  if (addMemberResult instanceof Error) {
    return addMemberResult
  }
}

async function executeScheduledTask({
  adapter,
  task,
}: {
  adapter: KimakiAdapter
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
      adapter,
      task,
      payload: payloadResult,
    })
  }

  return executeChannelScheduledTask({
    adapter,
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

  const timezone = task.timezone || getLocalTimeZone()
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
    const timezone = task.timezone || getLocalTimeZone()
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
  adapter,
  task,
}: {
  adapter: KimakiAdapter
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

  const executeResult = await executeScheduledTask({ adapter, task })
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
  adapter,
  staleRunningMs,
  dueBatchSize,
}: {
  adapter: KimakiAdapter
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
    await processDueTask({ adapter, task })
  }, Promise.resolve())
}

export function startTaskRunner({
  adapter,
  pollIntervalMs = 5_000,
  staleRunningMs = 120_000,
  dueBatchSize = 20,
}: StartTaskRunnerOptions): () => Promise<void> {
  let stopped = false
  let ticking = false
  let tickPromise: Promise<void> | null = null

  const tick = async () => {
    if (stopped || ticking) {
      return
    }

    ticking = true
    const currentTickPromise = runTaskRunnerTick({
      adapter,
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
