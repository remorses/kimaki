// Scheduled task parsing utilities for `send --send-at` and task runner execution.

import { CronExpressionParser } from 'cron-parser'
import * as errore from 'errore'

export type ScheduledTaskPayload = {
  preRunCommand: string | null
  allowConcurrency: boolean
} & (
  | {
      kind: 'thread'
      threadId: string
      prompt: string
      agent: string | null
      model: string | null
      username: string | null
      userId: string | null
      permissions: string[] | null
      injectionGuardPatterns: string[] | null
      parentSessionId: string | null
    }
  | {
      kind: 'channel'
      channelId: string
      prompt: string
      name: string | null
      notifyOnly: boolean
      worktreeName: string | null
      cwd: string | null
      agent: string | null
      model: string | null
      username: string | null
      userId: string | null
      permissions: string[] | null
      injectionGuardPatterns: string[] | null
      parentSessionId: string | null
    })

export type ParsedSendAt =
  | {
      scheduleKind: 'at'
      runAt: Date
      cronExpr: null
      timezone: null
      nextRunAt: Date
    }
  | {
      scheduleKind: 'cron'
      runAt: null
      cronExpr: string
      timezone: string
      nextRunAt: Date
    }

const UTC_SEND_AT_DATE_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/

export function getLocalTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!tz) {
    return 'UTC'
  }
  return tz
}

export function getPromptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 120) {
    return normalized
  }
  return `${normalized.slice(0, 117)}...`
}

function parseUtcSendAtDate({
  value,
  now,
}: {
  value: string
  now: Date
}): Date | Error | null {
  const looksLikeDate = value.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(value)
  if (!looksLikeDate) {
    return null
  }

  if (!UTC_SEND_AT_DATE_REGEX.test(value)) {
    return new Error(
      `--send-at date must be UTC ISO format ending with Z (example: 2026-03-01T09:00:00Z). Received: ${value}`,
    )
  }

  const runAt = new Date(value)
  if (Number.isNaN(runAt.getTime())) {
    return new Error(`Invalid UTC date for --send-at: ${value}`)
  }

  if (runAt.getTime() <= now.getTime()) {
    return new Error(`--send-at date must be in the future (UTC): ${value}`)
  }

  return runAt
}

const SLEEP_DURATION_REGEX = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i

const SLEEP_DURATION_MS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const

function parseUtcFutureDate({
  value,
  now,
  field,
}: {
  value: string
  now: Date
  field: string
}): Date | Error {
  if (!UTC_SEND_AT_DATE_REGEX.test(value)) {
    return new Error(
      `${field} must be UTC ISO format ending with Z (example: 2026-08-20T09:00:00Z). Received: ${value}`,
    )
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return new Error(`Invalid UTC date for ${field}: ${value}`)
  }

  if (parsed.getTime() <= now.getTime()) {
    return new Error(`${field} must be in the future (UTC): ${value}`)
  }

  return parsed
}

export function parseSleepWakeAt({
  duration,
  until,
  now,
}: {
  duration?: string
  until?: string
  now: Date
}): Date | Error {
  const trimmedDuration = duration?.trim() || ''
  const trimmedUntil = until?.trim() || ''
  if (trimmedDuration && trimmedUntil) {
    return new Error('Pass either duration or until, not both')
  }
  if (!trimmedDuration && !trimmedUntil) {
    return new Error('Pass duration or until')
  }

  if (trimmedUntil) {
    return parseUtcFutureDate({
      value: trimmedUntil,
      now,
      field: 'until',
    })
  }

  const match = SLEEP_DURATION_REGEX.exec(trimmedDuration)
  if (!match) {
    return new Error(
      `Invalid duration: "${trimmedDuration}". Use a number plus ms, s, m, h, or d (example: 2h).`,
    )
  }

  const amount = Number(match[1])
  const unit = match[2]!.toLowerCase() as keyof typeof SLEEP_DURATION_MS
  if (!Number.isFinite(amount) || amount <= 0) {
    return new Error('duration must be greater than 0')
  }

  return new Date(now.getTime() + amount * SLEEP_DURATION_MS[unit])
}

export function formatSessionSleepWakeAt(wakeAt: Date): string {
  return `${wakeAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function formatSessionSleepWakePrompt({
  wakeAt,
  reason,
}: {
  wakeAt: Date
  reason: string | null
}): string {
  const until = formatSessionSleepWakeAt(wakeAt)
  const reasonLine = reason?.trim() ? `\nReason: ${reason.trim()}` : ''
  return `⬦ Woke after sleeping until ${until}${reasonLine}\nContinue the work you were waiting for.`
}

export function parseSendAtValue({
  value,
  now,
  timezone,
}: {
  value: string
  now: Date
  timezone: string
}): ParsedSendAt | Error {
  const trimmed = value.trim()
  if (!trimmed) {
    return new Error('--send-at cannot be empty')
  }

  const utcDateResult = parseUtcSendAtDate({ value: trimmed, now })
  if (utcDateResult instanceof Error) return utcDateResult
  if (utcDateResult) {
    return {
      scheduleKind: 'at',
      runAt: utcDateResult,
      cronExpr: null,
      timezone: null,
      nextRunAt: utcDateResult,
    }
  }

  const looksLikeCron =
    trimmed.startsWith('@') || trimmed.split(/\s+/).length >= 5
  if (looksLikeCron) {
    const nextRunAtResult = getNextCronRun({
      cronExpr: trimmed,
      timezone,
      from: now,
    })
    if (!(nextRunAtResult instanceof Error)) {
      return {
        scheduleKind: 'cron',
        runAt: null,
        cronExpr: trimmed,
        timezone,
        nextRunAt: nextRunAtResult,
      }
    }
  }

  const cronResult = getNextCronRun({ cronExpr: trimmed, timezone, from: now })
  if (cronResult instanceof Error) {
    return new Error(
      `Invalid --send-at value: "${trimmed}". Use UTC ISO date/time ending in Z or a cron expression.`,
      {
        cause: cronResult,
      },
    )
  }

  return {
    scheduleKind: 'cron',
    runAt: null,
    cronExpr: trimmed,
    timezone,
    nextRunAt: cronResult,
  }
}

export function getNextCronRun({
  cronExpr,
  timezone,
  from,
}: {
  cronExpr: string
  timezone: string
  from: Date
}): Date | Error {
  const parsed = errore.try(
    () => {
      return CronExpressionParser.parse(cronExpr, {
        currentDate: from,
        tz: timezone,
      })
    },
    (error) => {
      return new Error(`Invalid cron expression: ${cronExpr}`, { cause: error })
    },
  )
  if (parsed instanceof Error) return parsed

  const next = errore.try(
    () => {
      return parsed.next().toDate()
    },
    (error) => {
      return new Error(`Could not compute next run for cron: ${cronExpr}`, {
        cause: error,
      })
    },
  )
  if (next instanceof Error) return next

  return next
}

export function serializeScheduledTaskPayload(
  payload: ScheduledTaskPayload,
): string {
  return JSON.stringify(payload)
}

export function appendTaskCommandOutput({
  prompt,
  stdout,
}: {
  prompt: string
  stdout: string
}): string {
  const output = stdout.trim()
  if (!output) return prompt
  return `${prompt}\n\n## Pre-run command output\n\n${output}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  return value
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value.filter((v): v is string => {
    return typeof v === 'string'
  })
}

export function parseScheduledTaskPayload(
  payloadJson: string,
): ScheduledTaskPayload | Error {
  const parsed = errore.try(
    () => {
      return JSON.parse(payloadJson) as unknown
    },
    (error) => {
      return new Error('Task payload is not valid JSON', { cause: error })
    },
  )
  if (parsed instanceof Error) return parsed
  if (!isRecord(parsed)) {
    return new Error('Task payload must be an object')
  }

  const kind = asString(parsed.kind)
  const preRunCommand = asString(parsed.preRunCommand)
  const allowConcurrency = parsed.allowConcurrency === true
  if (kind === 'thread') {
    const threadId = asString(parsed.threadId)
    const prompt = asString(parsed.prompt)
    const agent = asString(parsed.agent)
    const model = asString(parsed.model)
    const username = asString(parsed.username)
    const userId = asString(parsed.userId)
    const permissions = asStringArray(parsed.permissions)
    const injectionGuardPatterns = asStringArray(parsed.injectionGuardPatterns)
    const parentSessionId = asString(parsed.parentSessionId)
    if (!threadId || !prompt) {
      return new Error('Thread task payload requires threadId and prompt')
    }
    return {
      kind: 'thread',
      threadId,
      prompt,
      agent,
      model,
      username,
      userId,
      permissions,
      injectionGuardPatterns,
      parentSessionId,
      preRunCommand,
      allowConcurrency,
    }
  }

  if (kind === 'channel') {
    const channelId = asString(parsed.channelId)
    const prompt = asString(parsed.prompt)
    const nameValue = parsed.name
    const name = typeof nameValue === 'string' ? nameValue : null
    const notifyOnly = parsed.notifyOnly === true
    const worktreeName = asString(parsed.worktreeName)
    const cwd = asString(parsed.cwd)
    const agent = asString(parsed.agent)
    const model = asString(parsed.model)
    const username = asString(parsed.username)
    const userId = asString(parsed.userId)
    const permissions = asStringArray(parsed.permissions)
    const injectionGuardPatterns = asStringArray(parsed.injectionGuardPatterns)
    const parentSessionId = asString(parsed.parentSessionId)
    if (!channelId || !prompt) {
      return new Error('Channel task payload requires channelId and prompt')
    }
    return {
      kind: 'channel',
      channelId,
      prompt,
      name,
      notifyOnly,
      worktreeName,
      cwd,
      agent,
      model,
      username,
      userId,
      permissions,
      injectionGuardPatterns,
      parentSessionId,
      preRunCommand,
      allowConcurrency,
    }
  }

  return new Error('Task payload has unknown kind')
}
