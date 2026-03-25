// SQLite database manager for persistent bot state using Prisma.
// Stores thread-session mappings, bot tokens, channel directories,
// API keys, and model preferences in <dataDir>/discord-sessions.db.

import { getPrisma, closePrisma } from './db.js'
import type { Prisma, session_events, BotMode, VerbosityLevel, WorktreeStatus, ChannelType as PrismaChannelType } from './generated/client.js'
import crypto from 'node:crypto'

import { store } from './store.js'
import { createLogger, LogPrefix } from './logger.js'

const dbLogger = createLogger(LogPrefix.DB)

// Re-export Prisma utilities
export { getPrisma, closePrisma }

/**
 * Initialize the database.
 * Returns the Prisma client.
 */
export async function initDatabase() {
  const prisma = await getPrisma()
  dbLogger.log('Database initialized')
  return prisma
}

/**
 * Close the database connection.
 */
export async function closeDatabase() {
  await closePrisma()
}

// Re-export enum types from generated Prisma client
export type { VerbosityLevel }
export type { WorktreeStatus }
export type { PrismaChannelType }

export type ThreadWorktree = {
  thread_id: string
  worktree_name: string
  worktree_directory: string | null
  project_directory: string
  status: WorktreeStatus
  error_message: string | null
  created_at: Date | null
}

export type ScheduledTaskStatus =
  | 'planned'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'
export type ScheduledTaskScheduleKind = 'at' | 'cron'

export type ScheduledTask = {
  id: number
  status: ScheduledTaskStatus
  schedule_kind: ScheduledTaskScheduleKind
  run_at: Date | null
  cron_expr: string | null
  timezone: string | null
  next_run_at: Date
  running_started_at: Date | null
  last_run_at: Date | null
  last_error: string | null
  attempts: number
  payload_json: string
  prompt_preview: string
  channel_id: string | null
  thread_id: string | null
  session_id: string | null
  project_directory: string | null
  created_at: Date | null
  updated_at: Date | null
}

export type SessionStartSource = {
  session_id: string
  schedule_kind: ScheduledTaskScheduleKind
  scheduled_task_id: number | null
  created_at: Date | null
  updated_at: Date | null
}

function toScheduledTask(row: {
  id: number
  status: string
  schedule_kind: string
  run_at: Date | null
  cron_expr: string | null
  timezone: string | null
  next_run_at: Date
  running_started_at: Date | null
  last_run_at: Date | null
  last_error: string | null
  attempts: number
  payload_json: string
  prompt_preview: string
  channel_id: string | null
  thread_id: string | null
  session_id: string | null
  project_directory: string | null
  created_at: Date | null
  updated_at: Date | null
}): ScheduledTask {
  return {
    id: row.id,
    status: row.status as ScheduledTaskStatus,
    schedule_kind: row.schedule_kind as ScheduledTaskScheduleKind,
    run_at: row.run_at,
    cron_expr: row.cron_expr,
    timezone: row.timezone,
    next_run_at: row.next_run_at,
    running_started_at: row.running_started_at,
    last_run_at: row.last_run_at,
    last_error: row.last_error,
    attempts: row.attempts,
    payload_json: row.payload_json,
    prompt_preview: row.prompt_preview,
    channel_id: row.channel_id,
    thread_id: row.thread_id,
    session_id: row.session_id,
    project_directory: row.project_directory,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toSessionStartSource(row: {
  session_id: string
  schedule_kind: string
  scheduled_task_id: number | null
  created_at: Date | null
  updated_at: Date | null
}): SessionStartSource {
  return {
    session_id: row.session_id,
    schedule_kind: row.schedule_kind as ScheduledTaskScheduleKind,
    scheduled_task_id: row.scheduled_task_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ============================================================================
// Scheduled Task Functions
// ============================================================================

export async function createScheduledTask({
  scheduleKind,
  runAt,
  cronExpr,
  timezone,
  nextRunAt,
  payloadJson,
  promptPreview,
  channelId,
  threadId,
  sessionId,
  projectDirectory,
}: {
  scheduleKind: ScheduledTaskScheduleKind
  runAt?: Date | null
  cronExpr?: string | null
  timezone?: string | null
  nextRunAt: Date
  payloadJson: string
  promptPreview: string
  channelId?: string | null
  threadId?: string | null
  sessionId?: string | null
  projectDirectory?: string | null
}): Promise<number> {
  const prisma = await getPrisma()
  const row = await prisma.scheduled_tasks.create({
    data: {
      status: 'planned',
      schedule_kind: scheduleKind,
      run_at: runAt ?? null,
      cron_expr: cronExpr ?? null,
      timezone: timezone ?? null,
      next_run_at: nextRunAt,
      payload_json: payloadJson,
      prompt_preview: promptPreview,
      channel_id: channelId ?? null,
      thread_id: threadId ?? null,
      session_id: sessionId ?? null,
      project_directory: projectDirectory ?? null,
    },
    select: { id: true },
  })
  return row.id
}

export async function listScheduledTasks({
  statuses,
}: {
  statuses?: ScheduledTaskStatus[]
} = {}): Promise<ScheduledTask[]> {
  const prisma = await getPrisma()
  const rows = await prisma.scheduled_tasks.findMany({
    where:
      statuses && statuses.length > 0
        ? { status: { in: statuses } }
        : undefined,
    orderBy: [{ next_run_at: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => toScheduledTask(row))
}

export async function getScheduledTask(
  taskId: number,
): Promise<ScheduledTask | null> {
  const prisma = await getPrisma()
  const row = await prisma.scheduled_tasks.findUnique({
    where: { id: taskId },
  })
  return row ? toScheduledTask(row) : null
}

export async function updateScheduledTask({
  taskId,
  payloadJson,
  promptPreview,
  scheduleKind,
  runAt,
  cronExpr,
  timezone,
  nextRunAt,
}: {
  taskId: number
  payloadJson: string
  promptPreview: string
  scheduleKind?: ScheduledTaskScheduleKind
  runAt?: Date | null
  cronExpr?: string | null
  timezone?: string | null
  nextRunAt?: Date
}): Promise<boolean> {
  const prisma = await getPrisma()
  const data: Record<string, unknown> = {
    payload_json: payloadJson,
    prompt_preview: promptPreview,
  }
  if (scheduleKind !== undefined) {
    data.schedule_kind = scheduleKind
  }
  if (runAt !== undefined) {
    data.run_at = runAt
  }
  if (cronExpr !== undefined) {
    data.cron_expr = cronExpr
  }
  if (timezone !== undefined) {
    data.timezone = timezone
  }
  if (nextRunAt !== undefined) {
    data.next_run_at = nextRunAt
  }
  const result = await prisma.scheduled_tasks.updateMany({
    where: {
      id: taskId,
      status: 'planned',
    },
    data,
  })
  return result.count > 0
}

export async function cancelScheduledTask(taskId: number): Promise<boolean> {
  const prisma = await getPrisma()
  const result = await prisma.scheduled_tasks.updateMany({
    where: {
      id: taskId,
      status: {
        in: ['planned', 'running'],
      },
    },
    data: {
      status: 'cancelled',
      running_started_at: null,
    },
  })
  return result.count > 0
}

export async function getDuePlannedScheduledTasks({
  now,
  limit,
}: {
  now: Date
  limit: number
}): Promise<ScheduledTask[]> {
  const prisma = await getPrisma()
  const rows = await prisma.scheduled_tasks.findMany({
    where: {
      status: 'planned',
      next_run_at: {
        lte: now,
      },
    },
    orderBy: [{ next_run_at: 'asc' }, { id: 'asc' }],
    take: limit,
  })
  return rows.map((row) => toScheduledTask(row))
}

export async function claimScheduledTaskRunning({
  taskId,
  startedAt,
}: {
  taskId: number
  startedAt: Date
}): Promise<boolean> {
  const prisma = await getPrisma()
  const result = await prisma.scheduled_tasks.updateMany({
    where: {
      id: taskId,
      status: 'planned',
    },
    data: {
      status: 'running',
      running_started_at: startedAt,
    },
  })
  return result.count > 0
}

export async function recoverStaleRunningScheduledTasks({
  staleBefore,
}: {
  staleBefore: Date
}): Promise<number> {
  const prisma = await getPrisma()
  const result = await prisma.scheduled_tasks.updateMany({
    where: {
      status: 'running',
      running_started_at: {
        lte: staleBefore,
      },
    },
    data: {
      status: 'planned',
      running_started_at: null,
    },
  })
  return result.count
}

export async function markScheduledTaskOneShotCompleted({
  taskId,
  completedAt,
}: {
  taskId: number
  completedAt: Date
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.scheduled_tasks.update({
    where: { id: taskId },
    data: {
      status: 'completed',
      last_run_at: completedAt,
      running_started_at: null,
      last_error: null,
    },
  })
}

export async function markScheduledTaskCronRescheduled({
  taskId,
  completedAt,
  nextRunAt,
}: {
  taskId: number
  completedAt: Date
  nextRunAt: Date
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.scheduled_tasks.update({
    where: { id: taskId },
    data: {
      status: 'planned',
      last_run_at: completedAt,
      running_started_at: null,
      last_error: null,
      next_run_at: nextRunAt,
    },
  })
}

export async function markScheduledTaskFailed({
  taskId,
  failedAt,
  errorMessage,
}: {
  taskId: number
  failedAt: Date
  errorMessage: string
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.scheduled_tasks.update({
    where: { id: taskId },
    data: {
      status: 'failed',
      last_run_at: failedAt,
      running_started_at: null,
      last_error: errorMessage,
      attempts: {
        increment: 1,
      },
    },
  })
}

export async function markScheduledTaskCronRetry({
  taskId,
  failedAt,
  errorMessage,
  nextRunAt,
}: {
  taskId: number
  failedAt: Date
  errorMessage: string
  nextRunAt: Date
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.scheduled_tasks.update({
    where: { id: taskId },
    data: {
      status: 'planned',
      next_run_at: nextRunAt,
      last_run_at: failedAt,
      running_started_at: null,
      last_error: errorMessage,
      attempts: {
        increment: 1,
      },
    },
  })
}

export async function setSessionStartSource({
  sessionId,
  scheduleKind,
  scheduledTaskId,
}: {
  sessionId: string
  scheduleKind: ScheduledTaskScheduleKind
  scheduledTaskId?: number
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.session_start_sources.upsert({
    where: { session_id: sessionId },
    create: {
      session_id: sessionId,
      schedule_kind: scheduleKind,
      scheduled_task_id: scheduledTaskId ?? null,
    },
    update: {
      schedule_kind: scheduleKind,
      scheduled_task_id: scheduledTaskId ?? null,
    },
  })
}

export async function getSessionStartSourcesBySessionIds(
  sessionIds: string[],
): Promise<Map<string, SessionStartSource>> {
  if (sessionIds.length === 0) {
    return new Map<string, SessionStartSource>()
  }
  const prisma = await getPrisma()
  const chunkSize = 500
  const chunks: string[][] = []
  for (let index = 0; index < sessionIds.length; index += chunkSize) {
    chunks.push(sessionIds.slice(index, index + chunkSize))
  }

  const rowGroups = await Promise.all(
    chunks.map((chunkSessionIds) => {
      return prisma.session_start_sources.findMany({
        where: {
          session_id: {
            in: chunkSessionIds,
          },
        },
      })
    }),
  )
  const rows = rowGroups.flatMap((group) => group)
  return new Map(rows.map((row) => [row.session_id, toSessionStartSource(row)]))
}

// ============================================================================
// Channel Model Functions
// ============================================================================

export type ModelPreference = { modelId: string; variant: string | null }

/**
 * Get the model preference for a channel.
 * @returns Model ID in format "provider_id/model_id" + optional variant, or undefined
 */
export async function getChannelModel(
  channelId: string,
): Promise<ModelPreference | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.channel_models.findUnique({
    where: { channel_id: channelId },
  })
  if (!row) {
    return undefined
  }
  return { modelId: row.model_id, variant: row.variant }
}

/**
 * Set the model preference for a channel.
 * @param modelId Model ID in format "provider_id/model_id"
 * @param variant Optional thinking/reasoning variant name
 */
export async function setChannelModel({
  channelId,
  modelId,
  variant,
}: {
  channelId: string
  modelId: string
  variant?: string | null
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.channel_models.upsert({
    where: { channel_id: channelId },
    create: {
      channel_id: channelId,
      model_id: modelId,
      variant: variant ?? null,
    },
    update: {
      model_id: modelId,
      variant: variant ?? null,
      updated_at: new Date(),
    },
  })
}

// ============================================================================
// Global Model Functions
// ============================================================================

/**
 * Get the global default model for a bot.
 * @returns Model ID in format "provider_id/model_id" + optional variant, or undefined
 */
export async function getGlobalModel(
  appId: string,
): Promise<ModelPreference | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.global_models.findUnique({
    where: { app_id: appId },
  })
  if (!row) {
    return undefined
  }
  return { modelId: row.model_id, variant: row.variant }
}

/**
 * Set the global default model for a bot.
 * @param modelId Model ID in format "provider_id/model_id"
 * @param variant Optional thinking/reasoning variant name
 */
export async function setGlobalModel({
  appId,
  modelId,
  variant,
}: {
  appId: string
  modelId: string
  variant?: string | null
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.global_models.upsert({
    where: { app_id: appId },
    create: { app_id: appId, model_id: modelId, variant: variant ?? null },
    update: {
      model_id: modelId,
      variant: variant ?? null,
      updated_at: new Date(),
    },
  })
}

// ============================================================================
// Session Model Functions
// ============================================================================

/**
 * Get the model preference for a session.
 * @returns Model ID in format "provider_id/model_id" + optional variant, or undefined
 */
export async function getSessionModel(
  sessionId: string,
): Promise<ModelPreference | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.session_models.findUnique({
    where: { session_id: sessionId },
  })
  if (!row) {
    return undefined
  }
  return { modelId: row.model_id, variant: row.variant }
}

/**
 * Set the model preference for a session.
 * @param modelId Model ID in format "provider_id/model_id"
 * @param variant Optional thinking/reasoning variant name
 */
export async function setSessionModel({
  sessionId,
  modelId,
  variant,
}: {
  sessionId: string
  modelId: string
  variant?: string | null
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.session_models.upsert({
    where: { session_id: sessionId },
    create: {
      session_id: sessionId,
      model_id: modelId,
      variant: variant ?? null,
    },
    update: { model_id: modelId, variant: variant ?? null },
  })
}

/**
 * Clear the model preference for a session.
 * Used when switching agents so the agent's model takes effect.
 */
export async function clearSessionModel(sessionId: string): Promise<void> {
  const prisma = await getPrisma()
  await prisma.session_models.deleteMany({
    where: { session_id: sessionId },
  })
}

// ============================================================================
// Variant Cascade Resolution
// ============================================================================

/**
 * Resolve the variant (thinking level) using the session → channel → global cascade.
 * Returns the first non-null variant found, or undefined if none set at any level.
 */
export async function getVariantCascade({
  sessionId,
  channelId,
  appId,
}: {
  sessionId?: string
  channelId?: string
  appId?: string
}): Promise<string | undefined> {
  if (sessionId) {
    const session = await getSessionModel(sessionId)
    if (session?.variant) {
      return session.variant
    }
  }
  if (channelId) {
    const channel = await getChannelModel(channelId)
    if (channel?.variant) {
      return channel.variant
    }
  }
  if (appId) {
    const global = await getGlobalModel(appId)
    if (global?.variant) {
      return global.variant
    }
  }
  return undefined
}

// ============================================================================
// Channel Agent Functions
// ============================================================================

/**
 * Get the agent preference for a channel.
 */
export async function getChannelAgent(
  channelId: string,
): Promise<string | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.channel_agents.findUnique({
    where: { channel_id: channelId },
  })
  return row?.agent_name
}

/**
 * Set the agent preference for a channel.
 */
export async function setChannelAgent(
  channelId: string,
  agentName: string,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.channel_agents.upsert({
    where: { channel_id: channelId },
    create: { channel_id: channelId, agent_name: agentName },
    update: { agent_name: agentName, updated_at: new Date() },
  })
}

// ============================================================================
// Session Agent Functions
// ============================================================================

/**
 * Get the agent preference for a session.
 */
export async function getSessionAgent(
  sessionId: string,
): Promise<string | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.session_agents.findUnique({
    where: { session_id: sessionId },
  })
  return row?.agent_name
}

/**
 * Set the agent preference for a session.
 */
export async function setSessionAgent(
  sessionId: string,
  agentName: string,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.session_agents.upsert({
    where: { session_id: sessionId },
    create: { session_id: sessionId, agent_name: agentName },
    update: { agent_name: agentName },
  })
}

// ============================================================================
// Thread Worktree Functions
// ============================================================================

/**
 * Get the worktree info for a thread.
 */
export async function getThreadWorktree(
  threadId: string,
): Promise<ThreadWorktree | undefined> {
  const prisma = await getPrisma()
  return (await prisma.thread_worktrees.findUnique({
    where: { thread_id: threadId },
  })) ?? undefined
}

/**
 * Create a pending worktree entry for a thread.
 * Ensures the parent thread_sessions row exists first (with empty session_id)
 * to satisfy the FK constraint. The real session_id is set later by setThreadSession().
 */
export async function createPendingWorktree({
  threadId,
  worktreeName,
  projectDirectory,
}: {
  threadId: string
  worktreeName: string
  projectDirectory: string
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.$transaction([
    prisma.thread_sessions.upsert({
      where: { thread_id: threadId },
      create: { thread_id: threadId, session_id: '' },
      update: {},
    }),
    prisma.thread_worktrees.upsert({
      where: { thread_id: threadId },
      create: {
        thread_id: threadId,
        worktree_name: worktreeName,
        project_directory: projectDirectory,
        status: 'pending',
      },
      update: {
        worktree_name: worktreeName,
        project_directory: projectDirectory,
        status: 'pending',
        worktree_directory: null,
        error_message: null,
      },
    }),
  ])
}

/**
 * Mark a worktree as ready with its directory.
 */
export async function setWorktreeReady({
  threadId,
  worktreeDirectory,
}: {
  threadId: string
  worktreeDirectory: string
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.thread_worktrees.update({
    where: { thread_id: threadId },
    data: {
      worktree_directory: worktreeDirectory,
      status: 'ready',
    },
  })
}

/**
 * Mark a worktree as failed with error message.
 */
export async function setWorktreeError({
  threadId,
  errorMessage,
}: {
  threadId: string
  errorMessage: string
}): Promise<void> {
  const prisma = await getPrisma()
  await prisma.thread_worktrees.update({
    where: { thread_id: threadId },
    data: {
      status: 'error',
      error_message: errorMessage,
    },
  })
}

/**
 * Delete the worktree info for a thread.
 */
export async function deleteThreadWorktree(threadId: string): Promise<void> {
  const prisma = await getPrisma()
  await prisma.thread_worktrees.deleteMany({
    where: { thread_id: threadId },
  })
}

// ============================================================================
// Channel Verbosity Functions
// ============================================================================

/**
 * Get the verbosity setting for a channel.
 * Falls back to the global default set via --verbosity CLI flag if no per-channel override exists.
 */
export async function getChannelVerbosity(
  channelId: string,
): Promise<VerbosityLevel> {
  const prisma = await getPrisma()
  const row = await prisma.channel_verbosity.findUnique({
    where: { channel_id: channelId },
  })
  if (row?.verbosity) {
    return row.verbosity as VerbosityLevel
  }
  return store.getState().defaultVerbosity
}

/**
 * Set the verbosity setting for a channel.
 */
export async function setChannelVerbosity(
  channelId: string,
  verbosity: VerbosityLevel,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.channel_verbosity.upsert({
    where: { channel_id: channelId },
    create: { channel_id: channelId, verbosity },
    update: { verbosity, updated_at: new Date() },
  })
}

// ============================================================================
// Channel Mention Mode Functions
// ============================================================================

/**
 * Get the mention mode setting for a channel.
 * Falls back to the global default set via --mention-mode CLI flag if no per-channel override exists.
 */
export async function getChannelMentionMode(
  channelId: string,
): Promise<boolean> {
  const prisma = await getPrisma()
  const row = await prisma.channel_mention_mode.findUnique({
    where: { channel_id: channelId },
  })
  if (row) {
    return row.enabled === 1
  }
  return store.getState().defaultMentionMode
}

/**
 * Set the mention mode setting for a channel.
 */
export async function setChannelMentionMode(
  channelId: string,
  enabled: boolean,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.channel_mention_mode.upsert({
    where: { channel_id: channelId },
    create: { channel_id: channelId, enabled: enabled ? 1 : 0 },
    update: { enabled: enabled ? 1 : 0, updated_at: new Date() },
  })
}

// ============================================================================
// Channel Worktree Settings Functions
// ============================================================================

/**
 * Check if automatic worktree creation is enabled for a channel.
 */
export async function getChannelWorktreesEnabled(
  channelId: string,
): Promise<boolean> {
  const prisma = await getPrisma()
  const row = await prisma.channel_worktrees.findUnique({
    where: { channel_id: channelId },
  })
  return row?.enabled === 1
}

/**
 * Enable or disable automatic worktree creation for a channel.
 */
export async function setChannelWorktreesEnabled(
  channelId: string,
  enabled: boolean,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.channel_worktrees.upsert({
    where: { channel_id: channelId },
    create: { channel_id: channelId, enabled: enabled ? 1 : 0 },
    update: { enabled: enabled ? 1 : 0, updated_at: new Date() },
  })
}

// ============================================================================
// Channel Directory Functions
// ============================================================================

/**
 * Get the directory for a channel from the database.
 * This is the single source of truth for channel-project mappings.
 */
export async function getChannelDirectory(channelId: string): Promise<
  | {
      directory: string
    }
  | undefined
> {
  const prisma = await getPrisma()
  const row = await prisma.channel_directories.findUnique({
    where: { channel_id: channelId },
  })

  if (!row) {
    return undefined
  }

  return {
    directory: row.directory,
  }
}

// ============================================================================
// Thread Session Functions
// ============================================================================

/**
 * Get the session ID for a thread.
 */
export async function getThreadSession(
  threadId: string,
): Promise<string | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.thread_sessions.findUnique({
    where: { thread_id: threadId },
  })
  return row?.session_id
}

/**
 * Set the session ID for a thread.
 */
export async function setThreadSession(
  threadId: string,
  sessionId: string,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.thread_sessions.upsert({
    where: { thread_id: threadId },
    create: { thread_id: threadId, session_id: sessionId },
    update: { session_id: sessionId },
  })
}

/**
 * Get the thread ID for a session.
 */
export async function getThreadIdBySessionId(
  sessionId: string,
): Promise<string | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.thread_sessions.findFirst({
    where: { session_id: sessionId },
  })
  return row?.thread_id
}

/**
 * Get all session IDs that are associated with threads.
 */
export async function getAllThreadSessionIds(): Promise<string[]> {
  const prisma = await getPrisma()
  const rows = await prisma.thread_sessions.findMany({
    select: { session_id: true },
  })
  return rows.map((row) => row.session_id).filter((id) => id !== '')
}

export async function appendSessionEventsSinceLastTimestamp({
  sessionId,
  events,
}: {
  sessionId: string
  events: Prisma.session_eventsCreateManyInput[]
}): Promise<number> {
  if (events.length === 0) {
    return 0
  }

  const prisma = await getPrisma()
  const sortedEvents = [...events]
    .sort((a, b) => {
      if (a.timestamp < b.timestamp) {
        return -1
      }
      if (a.timestamp > b.timestamp) {
        return 1
      }
      if (a.event_index < b.event_index) {
        return -1
      }
      if (a.event_index > b.event_index) {
        return 1
      }
      return 0
    })

  const latestPersisted = await prisma.session_events.findFirst({
    where: {
      session_id: sessionId,
    },
    orderBy: [{ timestamp: 'desc' }, { event_index: 'desc' }, { id: 'desc' }],
    select: {
      timestamp: true,
      event_index: true,
    },
  })

  const eventsToInsert = sortedEvents.filter((event) => {
    if (!latestPersisted) {
      return true
    }
    if (event.timestamp > latestPersisted.timestamp) {
      return true
    }
    if (event.timestamp < latestPersisted.timestamp) {
      return false
    }
    return event.event_index > latestPersisted.event_index
  })

  if (eventsToInsert.length === 0) {
    return 0
  }

  await prisma.$transaction(async (tx) => {
    await tx.session_events.createMany({
      data: eventsToInsert,
    })

    const staleRows = await tx.session_events.findMany({
      where: {
        session_id: sessionId,
      },
      orderBy: [{ timestamp: 'desc' }, { event_index: 'desc' }, { id: 'desc' }],
      skip: 1000,
      select: {
        id: true,
      },
    })
    if (staleRows.length === 0) {
      return
    }

    await tx.session_events.deleteMany({
      where: {
        id: {
          in: staleRows.map((row) => {
            return row.id
          }),
        },
      },
    })
  })

  return eventsToInsert.length
}

export async function getSessionEventSnapshot({
  sessionId,
}: {
  sessionId: string
}): Promise<session_events[]> {
  const prisma = await getPrisma()
  return prisma.session_events.findMany({
    where: {
      session_id: sessionId,
    },
    orderBy: [{ timestamp: 'asc' }, { event_index: 'asc' }, { id: 'asc' }],
    take: 1000,
  })
}

// ============================================================================
// Part Messages Functions
// ============================================================================

/**
 * Get all part IDs for a thread.
 */
export async function getPartMessageIds(threadId: string): Promise<string[]> {
  const prisma = await getPrisma()
  const rows = await prisma.part_messages.findMany({
    where: { thread_id: threadId },
    select: { part_id: true },
  })
  return rows.map((row) => row.part_id)
}

/**
 * Store a part-message mapping.
 * Note: The thread must already have a session (via setThreadSession) before calling this.
 */
export async function setPartMessage(
  partId: string,
  messageId: string,
  threadId: string,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.part_messages.upsert({
    where: { part_id: partId },
    create: { part_id: partId, message_id: messageId, thread_id: threadId },
    update: { message_id: messageId, thread_id: threadId },
  })
}

/**
 * Store multiple part-message mappings in a transaction.
 * More efficient and atomic for batch operations.
 * Note: The thread must already have a session (via setThreadSession) before calling this.
 */
export async function setPartMessagesBatch(
  partMappings: Array<{ partId: string; messageId: string; threadId: string }>,
): Promise<void> {
  if (partMappings.length === 0) {
    return
  }
  const prisma = await getPrisma()
  await prisma.$transaction(
    partMappings.map(({ partId, messageId, threadId }) => {
      return prisma.part_messages.upsert({
        where: { part_id: partId },
        create: { part_id: partId, message_id: messageId, thread_id: threadId },
        update: { message_id: messageId, thread_id: threadId },
      })
    }),
  )
}

// ============================================================================
// Bot Token Functions
// ============================================================================

/**
 * Get the bot token to use, with mode info, in a single query.
 *
 * Selection logic (when multiple bot rows exist):
 * - If only one bot exists, use it regardless of mode.
 * - Picks the bot row with the most recent `last_used_at` timestamp, which is
 *   set by the `run()` command when the bot starts. This ensures subcommands
 *   in separate processes (send, project list, etc.) automatically use
 *   whichever bot mode (gateway or self-hosted) was last started.
 * - Falls back to `created_at` ordering when no row has `last_used_at` set
 *   (backward compat for existing DBs before this column was added).
 *
 * For gateway mode, the token is derived from client_id:client_secret
 * and REST routing is automatically enabled (idempotent env var set).
 * This ensures every code path that reads credentials gets correct routing
 * without needing to set discordBaseUrl separately.
 */
export async function getBotTokenWithMode(): Promise<
  | {
      appId: string
      token: string
      gatewayToken: string
      mode: BotMode
      clientId: string | null
      clientSecret: string | null
      proxyUrl: string | null
    }
  | undefined
> {
  const prisma = await getPrisma()
  // Pick the bot that was most recently started via run(). last_used_at is the
  // cross-process source of truth — no in-memory flags needed.
  // Fall back to created_at for DBs that predate the last_used_at column.
  const allBots = await prisma.bot_tokens.findMany({
    orderBy: [{ last_used_at: 'desc' }, { created_at: 'desc' }],
  })
  const row = allBots[0]
  if (!row) {
    return undefined
  }
  const gatewayToken = await ensureServiceAuthToken({ appId: row.app_id })
  const serviceParts = splitServiceAuthToken({ token: gatewayToken })
  const mode: BotMode = row.bot_mode === 'gateway' ? 'gateway' : 'self_hosted'
  const token = (mode === 'gateway' && serviceParts)
    ? gatewayToken
    : row.token
  // Always reset discordBaseUrl on every read so a mode switch within
  // the same process (e.g. DB has gateway row but user proceeds self-hosted)
  // doesn't leave a stale proxy URL in the store.
  const discordBaseUrl = (mode === 'gateway' && row.proxy_url)
    ? row.proxy_url
    : 'https://discord.com'
  store.setState({ discordBaseUrl, gatewayToken })
  return {
    appId: row.app_id,
    token,
    gatewayToken,
    mode,
    clientId: serviceParts?.clientId || row.client_id,
    clientSecret: serviceParts?.clientSecret || row.client_secret,
    proxyUrl: row.proxy_url,
  }
}

function splitServiceAuthToken({ token }: { token: string }): { clientId: string; clientSecret: string } | null {
  const separatorIndex = token.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex >= token.length - 1) {
    return null
  }
  return {
    clientId: token.slice(0, separatorIndex),
    clientSecret: token.slice(separatorIndex + 1),
  }
}

function createServiceCredentials(): { clientId: string; clientSecret: string } {
  return {
    clientId: crypto.randomUUID(),
    clientSecret: crypto.randomBytes(32).toString('hex'),
  }
}

export async function ensureServiceAuthToken({
  appId,
  preferredGatewayToken,
}: {
  appId: string
  preferredGatewayToken?: string
}): Promise<string> {
  const prisma = await getPrisma()
  const row = await prisma.bot_tokens.findUnique({
    where: { app_id: appId },
  })
  if (!row) {
    throw new Error(`Bot token row not found for app_id ${appId}`)
  }

  const preferred = preferredGatewayToken
    ? splitServiceAuthToken({ token: preferredGatewayToken })
    : null
  const existing = (row.client_id && row.client_secret)
    ? { clientId: row.client_id, clientSecret: row.client_secret }
    : null
  const fromStoredToken = splitServiceAuthToken({ token: row.token })
  const resolved = preferred || existing || fromStoredToken || createServiceCredentials()

  if (row.client_id !== resolved.clientId || row.client_secret !== resolved.clientSecret) {
    await prisma.bot_tokens.update({
      where: { app_id: appId },
      data: {
        client_id: resolved.clientId,
        client_secret: resolved.clientSecret,
      },
    })
  }

  return `${resolved.clientId}:${resolved.clientSecret}`
}

/**
 * Store a bot token.
 */
export async function setBotToken(appId: string, token: string): Promise<void> {
  const prisma = await getPrisma()
  const generated = createServiceCredentials()
  await prisma.bot_tokens.upsert({
    where: { app_id: appId },
    create: {
      app_id: appId,
      token,
      client_id: generated.clientId,
      client_secret: generated.clientSecret,
    },
    update: { token },
  })
  await ensureServiceAuthToken({ appId })
}

export type { BotMode }

/**
 * Persist gateway bot mode credentials.
 * Upserts the row so a prior setBotToken call is not needed.
 */
export async function setBotMode({
  appId,
  mode,
  clientId,
  clientSecret,
  proxyUrl,
}: {
  appId: string
  mode: BotMode
  clientId?: string | null
  clientSecret?: string | null
  proxyUrl?: string | null
}): Promise<void> {
  const prisma = await getPrisma()
  const data = {
    bot_mode: mode,
    client_id: clientId ?? null,
    client_secret: clientSecret ?? null,
    proxy_url: proxyUrl ?? null,
  }
  const createToken = (clientId && clientSecret) ? `${clientId}:${clientSecret}` : ''
  await prisma.bot_tokens.upsert({
    where: { app_id: appId },
    create: { app_id: appId, token: createToken, ...data },
    update: data,
  })
  await ensureServiceAuthToken({
    appId,
    preferredGatewayToken: (clientId && clientSecret) ? `${clientId}:${clientSecret}` : undefined,
  })
}



// ============================================================================
// Bot API Keys Functions
// ============================================================================

/**
 * Get the Gemini API key for a bot.
 */
export async function getGeminiApiKey(appId: string): Promise<string | null> {
  const prisma = await getPrisma()
  const row = await prisma.bot_api_keys.findUnique({
    where: { app_id: appId },
  })
  return row?.gemini_api_key ?? null
}

/**
 * Set the Gemini API key for a bot.
 * Note: The bot must already have a token (via setBotToken) before calling this.
 */
export async function setGeminiApiKey(
  appId: string,
  apiKey: string,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.bot_api_keys.upsert({
    where: { app_id: appId },
    create: { app_id: appId, gemini_api_key: apiKey },
    update: { gemini_api_key: apiKey },
  })
}

/**
 * Get the OpenAI API key for a bot.
 */
export async function getOpenAIApiKey(appId: string): Promise<string | null> {
  const prisma = await getPrisma()
  const row = await prisma.bot_api_keys.findUnique({
    where: { app_id: appId },
  })
  return row?.openai_api_key ?? null
}

/**
 * Set the OpenAI API key for a bot.
 */
export async function setOpenAIApiKey(
  appId: string,
  apiKey: string,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.bot_api_keys.upsert({
    where: { app_id: appId },
    create: { app_id: appId, openai_api_key: apiKey },
    update: { openai_api_key: apiKey },
  })
}

/**
 * Get the best available transcription API key for a bot.
 * Prefers OpenAI, falls back to Gemini.
 */
export async function getTranscriptionApiKey(
  appId: string,
): Promise<{ provider: 'openai' | 'gemini'; apiKey: string } | null> {
  const prisma = await getPrisma()
  const row = await prisma.bot_api_keys.findUnique({
    where: { app_id: appId },
  })
  if (!row) return null
  if (row.openai_api_key) {
    return { provider: 'openai', apiKey: row.openai_api_key }
  }
  if (row.gemini_api_key) {
    return { provider: 'gemini', apiKey: row.gemini_api_key }
  }
  return null
}

// ============================================================================
// Channel Directory CRUD Functions
// ============================================================================

/**
 * Store a channel-directory mapping.
 * @param skipIfExists If true, behaves like INSERT OR IGNORE - skips if record exists.
 *                     If false (default), behaves like INSERT OR REPLACE - updates if exists.
 */
export async function setChannelDirectory({
  channelId,
  directory,
  channelType,
  skipIfExists = false,
}: {
  channelId: string
  directory: string
  channelType: PrismaChannelType
  skipIfExists?: boolean
}): Promise<void> {
  const prisma = await getPrisma()
  if (skipIfExists) {
    // INSERT OR IGNORE semantics - only insert if not exists
    const existing = await prisma.channel_directories.findUnique({
      where: { channel_id: channelId },
    })
    if (existing) {
      return
    }
    await prisma.channel_directories.create({
      data: {
        channel_id: channelId,
        directory,
        channel_type: channelType,
      },
    })
  } else {
    // INSERT OR REPLACE semantics - upsert
    await prisma.channel_directories.upsert({
      where: { channel_id: channelId },
      create: {
        channel_id: channelId,
        directory,
        channel_type: channelType,
      },
      update: {
        directory,
        channel_type: channelType,
      },
    })
  }
}

/**
 * Find channels by directory path.
 */
export async function findChannelsByDirectory({
  directory,
  channelType,
}: {
  directory?: string
  channelType?: PrismaChannelType
}): Promise<
  Array<{ channel_id: string; directory: string; channel_type: string }>
> {
  const prisma = await getPrisma()
  const where: {
    directory?: string
    channel_type?: PrismaChannelType
  } = {}
  if (directory) {
    where.directory = directory
  }
  if (channelType) {
    where.channel_type = channelType
  }
  const rows = await prisma.channel_directories.findMany({
    where,
    select: { channel_id: true, directory: true, channel_type: true },
  })
  return rows
}

/**
 * Get all distinct directories with text channels.
 */
export async function getAllTextChannelDirectories(): Promise<string[]> {
  const prisma = await getPrisma()
  const rows = await prisma.channel_directories.findMany({
    where: { channel_type: 'text' },
    select: { directory: true },
    distinct: ['directory'],
  })
  return rows.map((row) => row.directory)
}

/**
 * Delete all channel directories for a specific directory.
 */
export async function deleteChannelDirectoriesByDirectory(
  directory: string,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.channel_directories.deleteMany({
    where: { directory },
  })
}

/**
 * Delete a single channel_directories row and all its child rows
 * (channel_models, channel_agents, channel_worktrees, channel_verbosity,
 * channel_mention_mode) in a single transaction. scheduled_tasks has
 * onDelete:SetNull so Prisma handles it automatically.
 */
export async function deleteChannelDirectoryById(
  channelId: string,
): Promise<boolean> {
  const prisma = await getPrisma()
  const deletedCount = await prisma.$transaction(async (tx) => {
    await tx.channel_models.deleteMany({ where: { channel_id: channelId } })
    await tx.channel_agents.deleteMany({ where: { channel_id: channelId } })
    await tx.channel_worktrees.deleteMany({ where: { channel_id: channelId } })
    await tx.channel_verbosity.deleteMany({ where: { channel_id: channelId } })
    await tx.channel_mention_mode.deleteMany({ where: { channel_id: channelId } })
    const result = await tx.channel_directories.deleteMany({
      where: { channel_id: channelId },
    })
    return result.count
  })
  return deletedCount > 0
}

/**
 * Get the directory for a voice channel.
 */
export async function getVoiceChannelDirectory(
  channelId: string,
): Promise<string | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.channel_directories.findFirst({
    where: { channel_id: channelId, channel_type: 'voice' },
  })
  return row?.directory
}

/**
 * Find the text channel ID that shares the same directory as a voice channel.
 * Used to send error messages to text channels from voice handlers.
 */
export async function findTextChannelByVoiceChannel(
  voiceChannelId: string,
): Promise<string | undefined> {
  const prisma = await getPrisma()
  // First get the directory for the voice channel
  const voiceChannel = await prisma.channel_directories.findFirst({
    where: { channel_id: voiceChannelId, channel_type: 'voice' },
  })
  if (!voiceChannel) {
    return undefined
  }
  // Then find the text channel with the same directory
  const textChannel = await prisma.channel_directories.findFirst({
    where: { directory: voiceChannel.directory, channel_type: 'text' },
  })
  return textChannel?.channel_id
}

// ============================================================================
// Forum Sync Config Functions
// ============================================================================

export type ForumSyncConfigRow = {
  appId: string
  forumChannelId: string
  outputDir: string
  direction: string
}

export async function getForumSyncConfigs({
  appId,
}: {
  appId: string
}): Promise<ForumSyncConfigRow[]> {
  const prisma = await getPrisma()
  const rows = await prisma.forum_sync_configs.findMany({
    where: { app_id: appId },
  })
  return rows.map((row) => ({
    appId: row.app_id,
    forumChannelId: row.forum_channel_id,
    outputDir: row.output_dir,
    direction: row.direction,
  }))
}

export async function upsertForumSyncConfig({
  appId,
  forumChannelId,
  outputDir,
  direction = 'bidirectional',
}: {
  appId: string
  forumChannelId: string
  outputDir: string
  direction?: string
}) {
  const prisma = await getPrisma()
  await prisma.forum_sync_configs.upsert({
    where: {
      app_id_forum_channel_id: {
        app_id: appId,
        forum_channel_id: forumChannelId,
      },
    },
    update: { output_dir: outputDir, direction },
    create: {
      app_id: appId,
      forum_channel_id: forumChannelId,
      output_dir: outputDir,
      direction,
    },
  })
}

export async function deleteForumSyncConfig({
  appId,
  forumChannelId,
}: {
  appId: string
  forumChannelId: string
}) {
  const prisma = await getPrisma()
  await prisma.forum_sync_configs.deleteMany({
    where: { app_id: appId, forum_channel_id: forumChannelId },
  })
}

/** Delete forum sync configs that share the same outputDir but have a different forumChannelId.
 * This cleans up stale entries left behind when a forum channel is deleted and recreated. */
export async function deleteStaleForumSyncConfigs({
  appId,
  forumChannelId,
  outputDir,
}: {
  appId: string
  forumChannelId: string
  outputDir: string
}) {
  const prisma = await getPrisma()
  await prisma.forum_sync_configs.deleteMany({
    where: {
      app_id: appId,
      output_dir: outputDir,
      NOT: { forum_channel_id: forumChannelId },
    },
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// IPC REQUESTS - plugin <-> bot communication via DB polling
// ═══════════════════════════════════════════════════════════════════════════

export async function createIpcRequest({
  type,
  sessionId,
  threadId,
  payload,
}: {
  type: import('./generated/client.js').ipc_request_type
  sessionId: string
  threadId: string
  payload: string
}) {
  const prisma = await getPrisma()
  return prisma.ipc_requests.create({
    data: {
      type,
      session_id: sessionId,
      thread_id: threadId,
      payload,
    },
  })
}

/**
 * Atomically claim pending IPC requests by updating status to 'processing'
 * only for rows that are still 'pending'. Returns the claimed rows.
 * This prevents duplicate dispatch when poll ticks overlap.
 */
export async function claimPendingIpcRequests() {
  const prisma = await getPrisma()
  const pending = await prisma.ipc_requests.findMany({
    where: { status: 'pending' },
    orderBy: { created_at: 'asc' },
  })
  if (pending.length === 0) return pending

  // Atomically claim each one (updateMany with status guard)
  const claimed: typeof pending = []
  for (const req of pending) {
    const result = await prisma.ipc_requests.updateMany({
      where: { id: req.id, status: 'pending' },
      data: { status: 'processing' },
    })
    if (result.count > 0) {
      claimed.push(req)
    }
  }
  return claimed
}

export async function completeIpcRequest({
  id,
  response,
}: {
  id: string
  response: string
}) {
  const prisma = await getPrisma()
  return prisma.ipc_requests.update({
    where: { id },
    data: { response, status: 'completed' as const },
  })
}

export async function getIpcRequestById({ id }: { id: string }) {
  const prisma = await getPrisma()
  return prisma.ipc_requests.findUnique({ where: { id } })
}

/** Cancel IPC requests stuck in 'processing' longer than the TTL (e.g. hung file upload). */
export async function cancelStaleProcessingRequests({
  ttlMs,
}: {
  ttlMs: number
}) {
  const prisma = await getPrisma()
  const cutoff = new Date(Date.now() - ttlMs)
  return prisma.ipc_requests.updateMany({
    where: {
      status: 'processing',
      updated_at: { lt: cutoff },
    },
    data: {
      status: 'cancelled' as const,
      response: JSON.stringify({ error: 'Request timed out' }),
    },
  })
}

/** Cancel all pending IPC requests (on startup cleanup and shutdown). */
export async function cancelAllPendingIpcRequests() {
  const prisma = await getPrisma()
  await prisma.ipc_requests.updateMany({
    where: { status: { in: ['pending', 'processing'] } },
    data: {
      status: 'cancelled' as const,
      response: JSON.stringify({ error: 'Bot shutting down' }),
    },
  })
}
