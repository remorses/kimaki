// Helpers shared by the CLI command modules. Commands exit through `fail` on
// errors, so their bodies read top to bottom without error plumbing.
// Never import bot modules (main.ts, onboarding.ts, scheduler.ts) here:
// every CLI process loads this file at startup. SQLite (drizzle) and
// discord.js are imported lazily too: loading them costs ~0.4s and ~250 MB per
// CLI call, and most commands only talk to the bot over the lock port.

import os from 'node:os'
import path from 'node:path'
import type { OpenCodeClient } from '@opencode/client'
import { ChannelType } from 'discord-api-types/v10'

import { BotNotRunningError, DbError } from '../errors.ts'
import { canonicalPath } from '../file-edit-log.ts'
import type { LockRouteInput, LockRouteName } from '../lock-routes.ts'
import { callBot } from '../lock-server.ts'
import { resolveOpencode } from '../opencode-server.ts'
import { readSessionMarkdown, resolveSession, waitForSessions, type WaitStatus } from '../session-events.ts'

export const DATA_DIR_HELP = 'Data directory (default: ~/.kimaki)'
export const SESSION_HELP = 'Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)'

// Prints the error and its cause chain: "Discord login failed" alone hides why.
export function fail(error: Error, code = 1): never {
  const lines = [error.message]
  for (let cause = error.cause; cause instanceof Error; cause = cause.cause) lines.push(`  caused by: ${cause.message}`)
  process.stderr.write(`${lines.join('\n')}\n`)
  process.exit(code)
}

export function dataDirOrDefault(dataDir: string | undefined): string {
  return path.resolve(dataDir ?? process.env['KIMAKI_DATA_DIR'] ?? path.join(os.homedir(), '.kimaki'))
}

export type SessionTarget = { sessionId: string; threadId?: undefined } | { threadId: string; sessionId?: undefined }

// One argument for every session command: `ses_…`, a thread snowflake, or a
// Discord thread URL (https://discord.com/channels/<guild>/<thread>).
export function parseTarget(value: string): SessionTarget | Error {
  const trimmed = value.trim()
  const url = trimmed.match(/^https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/\d+\/(\d+)(?:\/\d+)?\/?$/)
  if (url) return { threadId: url[1]! }
  if (/^\d{17,20}$/.test(trimmed)) return { threadId: trimmed }
  if (trimmed.startsWith('ses_')) return { sessionId: trimmed }
  return new Error(`Not a session ID, Discord thread ID or thread URL: ${value}`)
}

// The target of a session command; inside an agent shell OPENCODE_SESSION_ID is the default.
export function targetOrEnv(value: string | undefined): SessionTarget | Record<string, never> {
  const id = value ?? process.env['OPENCODE_SESSION_ID']
  if (!id) return {}
  const target = parseTarget(id)
  if (target instanceof Error) fail(target)
  return target
}

// Opens the existing database; the CLI never migrates (only the bot start does).
export async function openCliDb(dataDir: string | undefined) {
  const { openDb } = await import('../db.ts')
  const opened = await openDb({ dataDir: dataDirOrDefault(dataDir), migrate: false })
  if (opened instanceof Error) fail(opened)
  return opened
}

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

// `--json` prints the rows, otherwise one `line` per row.
export function printRows<T>({ json, rows, line }: { json: boolean | undefined; rows: T[]; line: (row: T) => string }) {
  if (json) return printJson(rows)
  process.stdout.write(rows.map((row) => `${line(row)}\n`).join(''))
}

export async function readClient(errorCode = 1): Promise<OpenCodeClient> {
  const endpoint = await resolveOpencode({ ensure: false, serviceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'] })
  if (endpoint instanceof Error) fail(endpoint, errorCode)
  return endpoint.client
}

// Thread and session of any target. Subagent sessions have no row: they keep threadId null.
export async function resolveTarget(value: string, dataDir: string | undefined): Promise<{ sessionId: string; threadId: string | null }> {
  const target = parseTarget(value)
  if (target instanceof Error) fail(target)
  const opened = await openCliDb(dataDir)
  const result = await resolveSession({ db: opened.db, id: target.sessionId ?? target.threadId })
  opened.close()
  if (!(result instanceof Error)) return result
  if (target.sessionId) return { sessionId: target.sessionId, threadId: null }
  fail(result)
}

function statusText({ sessionId, status, buttons, timeout }: { sessionId: string; status: WaitStatus; buttons: string[]; timeout: string }): string {
  // `kimaki buttons` ends the turn, so the run looks finished while the session waits for a click.
  if (buttons.length > 0 && status !== 'running' && status !== 'question' && status !== 'permission') {
    return `is paused: it showed buttons (${buttons.join(', ')}) and waits for the user to click one, so its work may not be done`
  }
  if (status === 'finished') return 'finished its run'
  if (status === 'failed') return 'ended its run with an error'
  if (status === 'interrupted') return 'was interrupted, by an abort or by a new user message that started another run'
  if (status === 'idle') return 'was already idle: its last run ended before the wait started'
  if (status === 'question') return 'is paused: it waits for the user to answer a question, so its work is not done'
  if (status === 'permission') return 'is paused: it waits for the user to allow a permission, so its work is not done'
  return `is still running after ${timeout}. Run kimaki session wait ${sessionId} to wait for the rest`
}

// Waits until every session ended its run or paused for the user, then prints each one in
// order under a header that says why it returned. Returns false when `signal` ended the wait first.
export async function waitAndPrintSessions({ client, sessionIds, dataDir, signal, timeout }: {
  client: OpenCodeClient
  sessionIds: readonly string[]
  dataDir: string | undefined
  signal?: AbortSignal
  timeout: string
}): Promise<boolean> {
  const statuses = await waitForSessions({ client, sessionIds, signal })
  if (statuses instanceof Error) fail(statuses)
  // Buttons live in the bot's memory. Without a bot nothing can show them.
  const buttons = await callBot({ dataDir: dataDirOrDefault(dataDir), route: 'session.buttons', input: { sessionIds: [...sessionIds] } })
  if (buttons instanceof Error && !(buttons instanceof BotNotRunningError)) process.stderr.write(`cannot read pending buttons: ${buttons.message}\n`)
  for (const sessionId of sessionIds) {
    const status = statuses.get(sessionId) ?? 'running'
    const text = statusText({ sessionId, status, buttons: buttons instanceof Error ? [] : buttons.data[sessionId] ?? [], timeout })
    const header = `=== ${sessionId} ${text} ===`
    if (status === 'running') {
      process.stdout.write(`${header}\n\n`)
      continue
    }
    const markdown = await readSessionMarkdown({ client, sessionId })
    if (markdown instanceof Error) fail(markdown)
    process.stdout.write(`${header}\n\n${markdown}\n\n`)
  }
  return [...statuses.values()].every((status) => status !== 'running')
}

// Discord REST with the bot token: KIMAKI_BOT_TOKEN (no kimaki.db needed, e.g. CI), else saved credentials.
export async function discordApi(dataDir: string | undefined) {
  const [{ envCredentials, gatewayUrlsFromEnv, readSavedCredentials, restApiUrl }, { createApi }] = await Promise.all([import('../credentials.ts'), import('../project.ts')])
  const credentials = await (async () => {
    const fromEnv = envCredentials({ urls: gatewayUrlsFromEnv() })
    if (fromEnv) return fromEnv
    const opened = await openCliDb(dataDir)
    const saved = await readSavedCredentials({ db: opened.db })
    opened.close()
    return saved
  })()
  if (credentials instanceof Error) fail(credentials)
  if (!credentials) fail(new Error('No saved bot credentials. Start Kimaki first, or set KIMAKI_BOT_TOKEN.'))
  return { credentials, api: createApi({ token: credentials.token, restUrl: process.env['KIMAKI_DISCORD_REST_URL'] ?? restApiUrl(credentials) }) }
}

type ThreadType = ChannelType.PublicThread | ChannelType.PrivateThread | ChannelType.AnnouncementThread

export function isThread<T extends { type: ChannelType }>(channel: T): channel is Extract<T, { type: ThreadType }> {
  return channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread || channel.type === ChannelType.AnnouncementThread
}

// Project directory: --channel resolves through SQLite, else --project, else the current directory.
export async function projectDirectory({ project, channel, dataDir }: { project: string | undefined; channel: string | undefined; dataDir: string | undefined }) {
  if (!channel) return canonicalPath(project ?? process.cwd())
  const opened = await openCliDb(dataDir)
  const row = await opened.db.query.channel_directories.findFirst({ where: { channel_id: channel } }).catch((cause) => new DbError({ operation: 'find channel', cause }))
  opened.close()
  if (row instanceof Error) fail(row)
  if (!row) fail(new Error(`No project directory for channel ${channel}`))
  return canonicalPath(row.directory)
}

// Runs a lock route on the running bot and prints its JSON result.
export async function action<N extends LockRouteName>({ route, dataDir, input, signal }: { route: N; dataDir: string | undefined; input: LockRouteInput<N>; signal?: AbortSignal }) {
  const result = await callBot({ dataDir: dataDirOrDefault(dataDir), route, input, signal })
  if (result instanceof Error) fail(result)
  process.stdout.write(`${JSON.stringify(result.data)}\n`)
}
