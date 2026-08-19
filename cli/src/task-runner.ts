// Scheduled task runner for due `send --send-at` jobs and session sleep wakes.

import { DiscordAPIError, type REST, Routes } from 'discord.js'
import { createDiscordRest } from './discord-urls.js'
import { ensureThreadMember } from './discord-utils.js'
import YAML from 'yaml'
import {
  claimScheduledTaskRunning,
  createScheduledTaskRun,
  failScheduledTaskRun,
  finishScheduledTaskRun,
  getDuePlannedScheduledTasks,
  getScheduledTask,
  getActiveScheduledTaskRuns,
  markScheduledTaskCronRescheduled,
  markScheduledTaskCronRetry,
  markScheduledTaskFailed,
  deleteScheduledTask,
  recoverStaleRunningScheduledTasks,
  releaseScheduledTaskClaim,
  setScheduledTaskRunThread,
  type ScheduledTask,
  type SessionSleep,
  claimSessionSleepAttempt,
  getDueSessionSleeps,
  getThreadIdBySessionId,
  markSessionSleepFailed,
} from './database.js'
import { execAsync } from './exec-async.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import { createLogger, formatErrorWithStack, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'
import type { ThreadStartMarker } from './system-message.js'
import {
  type ScheduledTaskPayload,
  appendTaskCommandOutput,
  formatSessionSleepWakePrompt,
  getNextCronRun,
  getPromptPreview,
  parseScheduledTaskPayload,
} from './task-schedule.js'

const taskLogger = createLogger(LogPrefix.TASK)
const MAX_SCHEDULED_PROMPT_LENGTH = 1_900
const PENDING_RUN_TIMEOUT_MS = 120_000

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
  prompt,
  runId,
}: {
  rest: REST
  task: ScheduledTask
  payload: Extract<ScheduledTaskPayload, { kind: 'thread' }>
  prompt: string
  runId?: number
}): Promise<string | Error> {
  const marker: ThreadStartMarker = {
    start: true,
    scheduledKind: task.schedule_kind,
    // Only include scheduledTaskId for cron tasks. One-shot tasks are deleted
    // after execution, so the ID would be stale by the time the bot processes
    // the Discord event and tries to insert a session_start_sources row.
    ...(task.schedule_kind === 'cron' ? { scheduledTaskId: task.id } : {}),
    ...(runId ? { scheduledTaskRunId: runId } : {}),
    ...(payload.agent ? { agent: payload.agent } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.username ? { username: payload.username } : {}),
    ...(payload.userId ? { userId: payload.userId } : {}),
    ...(payload.permissions?.length ? { permissions: payload.permissions } : {}),
    ...(payload.injectionGuardPatterns?.length
      ? { injectionGuardPatterns: payload.injectionGuardPatterns }
      : {}),
    ...(payload.parentSessionId ? { parentSessionId: payload.parentSessionId } : {}),
  }
  const embed = [{ color: 0x2b2d31, footer: { text: YAML.stringify(marker) } }]
  // Newline between prefix and prompt so leading /command detection can
  // find the command on its own line.
  const prefixedPrompt = `» **kimaki-cli:**\n${prompt}`

  // Re-join the user before posting, so the message they get notified about is
  // in a thread they are already a member of. Works on archived threads too;
  // the post below auto-unarchives.
  if (payload.userId) {
    const addMemberResult = await ensureThreadMember({
      rest,
      threadId: payload.threadId,
      userId: payload.userId,
    })
    if (addMemberResult instanceof Error) {
      return new Error(
        `Failed to add user to scheduled thread for task ${task.id}`,
        { cause: addMemberResult },
      )
    }
  }

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

  if (postResult instanceof Error) return postResult
  return payload.threadId
}

/** Wait before retrying a wake that ingress has not consumed yet. */
const SLEEP_WAKE_RETRY_AFTER_MS = 30_000
const SLEEP_WAKE_MAX_ATTEMPTS = 5

type SleepWakeFailure = { error: Error; permanent: boolean }

async function postSessionSleepWake({
  rest,
  sleep,
  threadId,
}: {
  rest: REST
  sleep: SessionSleep
  threadId: string
}): Promise<SleepWakeFailure | null> {
  const marker: ThreadStartMarker = {
    start: true,
    sleepWake: true,
    sleepId: sleep.delivery_id,
  }
  const prompt = formatSessionSleepWakePrompt({
    wakeAt: sleep.wake_at,
    reason: sleep.reason,
  })
  // `.then(() => null)` keeps the success type concrete. Returning the raw post
  // value would widen the union to `unknown` and erase the failure shape.
  return await rest
    .post(Routes.channelMessages(threadId), {
      body: {
        content: prompt,
        embeds: [{ color: 0x2b2d31, footer: { text: YAML.stringify(marker) } }],
        // A lost response does not mean Discord rejected the post. Retrying with
        // the same nonce returns the existing message instead of creating a
        // second one, so a retry can never produce two wake turns.
        nonce: sleep.delivery_id,
        enforce_nonce: true,
      },
    })
    .then((): SleepWakeFailure | null => {
      return null
    })
    .catch((error): SleepWakeFailure => {
      // Only an unknown channel/message is genuinely unrecoverable. A 403 is
      // often temporary (permissions revoked, thread locked) so it keeps
      // retrying until the attempt budget runs out.
      const permanent =
        error instanceof DiscordAPIError &&
        error.status === 404
      return {
        error: new Error(
          `Failed to post sleep wake for session ${sleep.session_id}`,
          { cause: error },
        ),
        permanent,
      }
    })
}

export async function wakeDueSessionSleeps({
  rest,
  now = new Date(),
  limit = 20,
}: {
  rest: REST
  now?: Date
  limit?: number
}): Promise<void> {
  const dueSleeps = await getDueSessionSleeps({
    now,
    retryAfterMs: SLEEP_WAKE_RETRY_AFTER_MS,
    limit,
  })
  for (const sleep of dueSleeps) {
    // Reserves an attempt but stays `planned`. The row only leaves `planned`
    // when ingress consumes the wake, so dying anywhere below costs one retry
    // delay instead of losing the wake.
    const claimed = await claimSessionSleepAttempt({
      sessionId: sleep.session_id,
      deliveryId: sleep.delivery_id,
      now,
      retryAfterMs: SLEEP_WAKE_RETRY_AFTER_MS,
    })
    if (!claimed) continue

    // Resolved now, not when the tool ran, so a session rebound by /resume
    // wakes in the thread that currently owns it.
    const threadId = await getThreadIdBySessionId(claimed.session_id)
    if (!threadId) {
      await markSessionSleepFailed({
        sessionId: claimed.session_id,
        deliveryId: claimed.delivery_id,
      })
      taskLogger.warn(
        `[task-runner] no thread owns session ${claimed.session_id}, dropping sleep wake`,
      )
      continue
    }

    // A successful post changes nothing here on purpose: ingress owns the
    // transition out of `planned` when the wake actually becomes a turn.
    const postResult = await postSessionSleepWake({ rest, sleep: claimed, threadId })
    if (!postResult) continue

    const exhausted = claimed.attempts >= SLEEP_WAKE_MAX_ATTEMPTS
    if (postResult.permanent || exhausted) {
      await markSessionSleepFailed({
        sessionId: claimed.session_id,
        deliveryId: claimed.delivery_id,
      })
    }
    taskLogger.error(`[task-runner] ${formatErrorWithStack(postResult.error)}`)
    void notifyError(postResult.error, 'Session sleep wake failed')
  }
}

async function executeChannelScheduledTask({
  rest,
  task,
  payload,
  prompt,
  runId,
}: {
  rest: REST
  task: ScheduledTask
  payload: Extract<ScheduledTaskPayload, { kind: 'channel' }>
  prompt: string
  runId?: number
}): Promise<string | null | Error> {
  const marker: ThreadStartMarker | undefined = payload.notifyOnly
    ? undefined
    : {
        start: true,
        scheduledKind: task.schedule_kind,
        // Only include scheduledTaskId for cron tasks (see thread variant comment)
        ...(task.schedule_kind === 'cron' ? { scheduledTaskId: task.id } : {}),
        ...(runId ? { scheduledTaskRunId: runId } : {}),
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
        ...(payload.parentSessionId ? { parentSessionId: payload.parentSessionId } : {}),
      }
  const embeds = marker
    ? [{ color: 0x2b2d31, footer: { text: YAML.stringify(marker) } }]
    : undefined

  const starterResult = await rest
    .post(Routes.channelMessages(payload.channelId), {
      body: {
        content: prompt,
        embeds,
      },
    })
    .catch((error) => {
      return new Error(`Failed to create starter message for task ${task.id}`, {
        cause: error,
      })
    })

  if (starterResult instanceof Error) return starterResult

  const starterMessageId = parseMessageId(starterResult)
  if (starterMessageId instanceof Error) {
    return new Error(`Invalid starter message response for task ${task.id}`, {
      cause: starterMessageId,
    })
  }

  const threadName = (payload.name || getPromptPreview(prompt)).slice(
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

  if (threadResult instanceof Error) return threadResult

  const threadIdResult = parseMessageId(threadResult)
  if (threadIdResult instanceof Error) {
    return new Error(`Invalid thread response for task ${task.id}`, {
      cause: threadIdResult,
    })
  }

  if (!payload.userId) return threadIdResult

  const addMemberResult = await ensureThreadMember({
    rest,
    threadId: threadIdResult,
    userId: payload.userId,
  })
  if (addMemberResult instanceof Error) {
    return new Error(
      `Failed to add user to scheduled thread for task ${task.id}`,
      { cause: addMemberResult },
    )
  }
  return threadIdResult
}

export async function runTaskCommand({
  task,
  payload,
}: {
  task: ScheduledTask
  payload: ScheduledTaskPayload
}): Promise<{ kind: 'run'; prompt: string } | { kind: 'skip' } | Error> {
  if (!payload.preRunCommand) return { kind: 'run', prompt: payload.prompt }
  if (!task.project_directory) {
    return new Error(`Task ${task.id} has a pre-run command but no project directory`)
  }

  const command = payload.preRunCommand
  const result = await execAsync(command, { cwd: task.project_directory }).catch(
    (error) => error instanceof Error ? error : new Error(String(error)),
  )
  const stdout = isRecord(result) && typeof result.stdout === 'string'
    ? result.stdout
    : ''
  const stderr = isRecord(result) && typeof result.stderr === 'string'
    ? result.stderr
    : ''
  const exitCode = result instanceof Error && isRecord(result)
    ? result.code ?? 1
    : 0
  if (stdout) taskLogger.log(`[task-runner] task ${task.id} pre-run stdout:\n${stdout}`)
  if (stderr) taskLogger.log(`[task-runner] task ${task.id} pre-run stderr:\n${stderr}`)
  taskLogger.log(`[task-runner] task ${task.id} pre-run exited with ${exitCode}`)
  if (result instanceof Error) return { kind: 'skip' }

  const prompt = appendTaskCommandOutput({ prompt: payload.prompt, stdout })
  if (prompt.length > MAX_SCHEDULED_PROMPT_LENGTH) {
    return new Error(
      `Task ${task.id} prompt and pre-run stdout exceed ${MAX_SCHEDULED_PROMPT_LENGTH} characters`,
    )
  }
  return { kind: 'run', prompt }
}

async function hasRunningSession(task: ScheduledTask): Promise<boolean | Error> {
  const runs = await getActiveScheduledTaskRuns(task.id)
  if (runs.length === 0) return false

  let active = false
  for (const run of runs) {
    if (!run.session_id) {
      if (Date.now() - run.started_at.getTime() < PENDING_RUN_TIMEOUT_MS) {
        active = true
        continue
      }
      await failScheduledTaskRun({
        runId: run.id,
        error: 'Timed out waiting for scheduled session to start',
      })
      continue
    }
    if (!run.project_directory) {
      active = true
      continue
    }
    const getClient = await initializeOpencodeForDirectory(run.project_directory)
    if (getClient instanceof Error) return getClient
    const statusResponse = await getClient().session.status({
      directory: run.project_directory,
    }).catch((error) => new Error('Failed to check scheduled session status', {
      cause: error,
    }))
    if (statusResponse instanceof Error) return statusResponse
    if (statusResponse.error) return new Error('Failed to check scheduled session status')
    const status = statusResponse.data?.[run.session_id]
    if (status && status.type !== 'idle') {
      active = true
      continue
    }
    if (!status && Date.now() - run.started_at.getTime() < PENDING_RUN_TIMEOUT_MS) {
      active = true
      continue
    }
    await finishScheduledTaskRun({ runId: run.id, status: 'completed' })
  }
  return active
}

async function executeScheduledTask({
  rest,
  task,
  runId,
}: {
  rest: REST
  task: ScheduledTask
  runId?: number
}): Promise<string | null | Error | { kind: 'condition-not-met' }> {
  const payloadResult = parseScheduledTaskPayload(task.payload_json)
  if (payloadResult instanceof Error) {
    return new Error(`Task ${task.id} has invalid payload`, {
      cause: payloadResult,
    })
  }

  const commandResult = await runTaskCommand({ task, payload: payloadResult })
  if (commandResult instanceof Error) return commandResult
  if (commandResult.kind === 'skip') return { kind: 'condition-not-met' }

  if (payloadResult.kind === 'thread') {
    return executeThreadScheduledTask({
      rest,
      task,
      payload: payloadResult,
      prompt: commandResult.prompt,
      runId,
    })
  }

  return executeChannelScheduledTask({
    rest,
    task,
    payload: payloadResult,
    prompt: commandResult.prompt,
    runId,
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
    await deleteScheduledTask(task.id)
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

export type ProcessDueTaskResult =
  | { kind: 'skipped' }
  | { kind: 'condition-not-met' }
  | { kind: 'concurrency-blocked' }
  | { kind: 'success' }
  | { kind: 'failed'; error: Error }

async function processDueTask({
  rest,
  task,
}: {
  rest: REST
  task: ScheduledTask
}): Promise<ProcessDueTaskResult> {
  const startedAt = new Date()
  const claimed = await claimScheduledTaskRunning({
    taskId: task.id,
    startedAt,
  })
  if (!claimed) {
    return { kind: 'skipped' }
  }

  const payload = parseScheduledTaskPayload(task.payload_json)
  if (payload instanceof Error) {
    await finalizeFailedTask({ task, failedAt: new Date(), error: payload })
    return { kind: 'failed', error: payload }
  }
  const activeSession = payload.allowConcurrency
    ? false
    : await hasRunningSession(task)
  if (activeSession instanceof Error) {
    await releaseScheduledTaskClaim(task.id)
    taskLogger.warn(
      `[task-runner] could not check concurrency for task ${task.id}: ${formatErrorWithStack(activeSession)}`,
    )
    return { kind: 'failed', error: activeSession }
  }
  if (activeSession) {
    if (task.schedule_kind === 'cron') {
      await finalizeSuccessfulTask({ task, completedAt: new Date() })
    } else {
      await releaseScheduledTaskClaim(task.id)
    }
    return { kind: 'concurrency-blocked' }
  }

  const runId = task.schedule_kind === 'cron'
    ? await createScheduledTaskRun({ taskId: task.id, startedAt })
    : undefined

  const executeResult = await executeScheduledTask({ rest, task, runId })
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
    if (runId) await failScheduledTaskRun({ runId, error: executeResult.message })
    return { kind: 'failed', error: executeResult }
  }

  if (!(typeof executeResult === 'string' || executeResult === null)) {
    if (runId) await finishScheduledTaskRun({ runId, status: 'skipped' })
    await finalizeSuccessfulTask({ task, completedAt: finishedAt })
    return executeResult
  }

  if (executeResult && runId) {
    await setScheduledTaskRunThread({ runId, threadId: executeResult })
  } else if (runId) {
    await finishScheduledTaskRun({ runId, status: 'completed' })
  }

  await finalizeSuccessfulTask({ task, completedAt: finishedAt })
  return { kind: 'success' }
}

// Same claim → execute → finalize path as the poller. Used by /tasks Run now.
export async function runScheduledTaskNow({
  token,
  taskId,
}: {
  token: string
  taskId: number
}): Promise<ProcessDueTaskResult | Error> {
  const task = await getScheduledTask(taskId)
  if (!task) {
    return new Error(`Task #${taskId} not found`)
  }
  if (task.status !== 'planned') {
    return new Error(
      `Task #${taskId} is ${task.status}; only planned tasks can be run now`,
    )
  }

  const rest = createDiscordRest(token)
  return processDueTask({ rest, task })
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

  await wakeDueSessionSleeps({ rest })
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
