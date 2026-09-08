// v2 facts → Discord messages. Banner, text, footer, queue drain line.

import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DiscordAPIError, HTTPError, type ThreadChannel } from 'discord.js'
import { Plugin } from '@opencode-ai/plugin'
import {
  contextPercent,
  lastExecutionStartedAt,
  sessionModel,
  shouldShowFooter,
  type EventEntry,
} from '../../src/event-stream-state.ts'
import { splitDiscordContent } from '../../src/discord-text.ts'
import { getClient, logPluginError } from '../discord/client.ts'
import { findBySessionId } from '../threads/registry.ts'

const execFileAsync = promisify(execFile)
const SILENT = 4 | 4096
const NOTIFY = 4
const FACTS_MAX = 1000
const RETAINED_FACT_TYPES = new Set([
  'session.created',
  'session.step.started',
  'session.step.ended',
  'session.usage.updated',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.status',
  'session.idle',
  'session.inbox.enqueued',
  'session.inbox.cancelled',
  'session.inbox.delivered',
  'session.inbox.delivery.changed',
])

type InboxPending = {
  text: string
  username: string
  delivery: string
}

type BusEvent = {
  type: string
  location?: { directory?: string }
  data?: {
    sessionID?: string
    inboxID?: string
    text?: string
    status?: string | { type?: string }
    location?: { directory?: string }
    model?: { id?: string; providerID?: string }
    tokens?: {
      input?: number
      output?: number
      reasoning?: number
      cache?: { read?: number; write?: number }
    }
    delivery?: string
    item?: {
      payload?: {
        text?: string
        metadata?: { username?: unknown }
      }
      delivery?: string
    }
  }
}

function sessionIdOf(event: BusEvent) {
  return typeof event.data?.sessionID === 'string' ? event.data.sessionID : undefined
}

function directoryForSession({
  sessionID,
  sessionDirectories,
}: {
  sessionID: string
  sessionDirectories: Map<string, string>
}) {
  return findBySessionId(sessionID)?.directory ?? sessionDirectories.get(sessionID)
}

function isForThisDirectory({
  event,
  directory,
  sessionDirectories,
}: {
  event: BusEvent
  directory: string
  sessionDirectories: Map<string, string>
}) {
  if (event.location?.directory === directory) return true
  if (event.location?.directory) return false
  const sessionID = sessionIdOf(event)
  if (!sessionID) return false
  return directoryForSession({ sessionID, sessionDirectories }) === directory
}

function rememberSessionDirectory({
  event,
  sessionDirectories,
}: {
  event: BusEvent
  sessionDirectories: Map<string, string>
}) {
  if (event.type !== 'session.created') return
  const sessionID = sessionIdOf(event)
  const directory = event.location?.directory ?? event.data?.location?.directory
  if (!sessionID || !directory) return
  sessionDirectories.set(sessionID, directory)
}

async function gitBranch(directory: string) {
  const result = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: directory,
  }).catch(() => null)
  return result?.stdout.trim() || 'main'
}

function textOf(event: BusEvent) {
  return typeof event.data?.text === 'string' ? event.data.text : ''
}

function toFact(event: BusEvent): EventEntry {
  return {
    timestamp: Date.now(),
    event: {
      type: event.type,
      data: event.data
        ? {
            sessionID: sessionIdOf(event),
            inboxID: typeof event.data.inboxID === 'string' ? event.data.inboxID : undefined,
            status: event.data.status,
            model: event.data.model,
            tokens: event.data.tokens,
          }
        : undefined,
    },
  }
}

function isDiscordHttpError(error: unknown) {
  return error instanceof DiscordAPIError || error instanceof HTTPError
}

async function send(
  thread: ThreadChannel,
  content: string,
  flags: number,
  allowedMentions: { parse: []; users?: string[] } = { parse: [] },
) {
  for (const chunk of splitDiscordContent(content)) {
    const result = await thread
      .send({ content: chunk, flags, allowedMentions })
      .catch((error: unknown) => error)
    if (isDiscordHttpError(result)) return
    if (result instanceof Error) throw result
  }
}

export default Plugin.define({
  id: 'kimaki.render',
  async setup(ctx) {
    const facts: EventEntry[] = []
    const banners = new Set<string>()
    const inbox = new Map<string, InboxPending>()
    const sessionDirectories = new Map<string, string>()
    const controller = new AbortController()
    const sub = ctx.event.subscribe({ signal: controller.signal })
    void (async () => {
      for await (const event of sub) {
        if (controller.signal.aborted) return
        const busEvent = event as BusEvent
        rememberSessionDirectory({ event: busEvent, sessionDirectories })
        if (!isForThisDirectory({
          event: busEvent,
          directory: ctx.location.directory,
          sessionDirectories,
        })) continue
        if (RETAINED_FACT_TYPES.has(busEvent.type)) {
          facts.push(toFact(busEvent))
          if (facts.length > FACTS_MAX) facts.splice(0, facts.length - FACTS_MAX)
        }
        const handled = await handleEvent({ event: busEvent, facts, banners, inbox }).catch(
          (error: unknown) => error,
        )
        if (handled instanceof Error) logPluginError(handled)
      }
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return
      if (error instanceof Error && error.name === 'AbortError') return
      logPluginError(error)
    })
    return () => {
      controller.abort()
    }
  },
})

async function handleEvent({
  event,
  facts,
  banners,
  inbox,
}: {
  event: BusEvent
  facts: EventEntry[]
  banners: Set<string>
  inbox: Map<string, InboxPending>
}) {
  const sessionID = sessionIdOf(event)
  if (!sessionID) return
  const record = findBySessionId(sessionID)
  if (!record) return
  const client = getClient()
  if (!client) return
  const thread = await client.channels.fetch(record.threadId)
  if (!thread || !thread.isThread()) return

  if (!banners.has(sessionID)) {
    const model = sessionModel({ events: facts, sessionId: sessionID })
    if (model) {
      banners.add(sessionID)
      await send(thread, `*using ${model.providerID}/${model.modelID}*`, SILENT)
    }
  }
  if (event.type === 'session.created') return

  if (event.type === 'session.inbox.enqueued') {
    const inboxID = event.data?.inboxID
    if (typeof inboxID !== 'string') return
    const item = event.data?.item
    const username = item?.payload?.metadata?.username
    inbox.set(inboxID, {
      text: item?.payload?.text ?? '',
      username: typeof username === 'string' ? username : record.username,
      delivery: item?.delivery ?? '',
    })
    return
  }

  if (event.type === 'session.inbox.delivery.changed') {
    const inboxID = event.data?.inboxID
    const delivery = event.data?.delivery
    if (typeof inboxID !== 'string' || typeof delivery !== 'string') return
    const pending = inbox.get(inboxID)
    if (pending) pending.delivery = delivery
    return
  }

  if (event.type === 'session.inbox.cancelled') {
    const inboxID = event.data?.inboxID
    if (typeof inboxID === 'string') inbox.delete(inboxID)
    return
  }

  if (event.type === 'session.inbox.delivered') {
    const inboxID = event.data?.inboxID
    if (typeof inboxID !== 'string') return
    const pending = inbox.get(inboxID)
    inbox.delete(inboxID)
    if (pending?.delivery === 'queue') {
      await send(thread, `» **${pending.username}:** ${pending.text}`, SILENT)
    }
    return
  }

  if (event.type === 'session.text.ended') {
    const text = textOf(event)
    if (text) await send(thread, text, SILENT)
    return
  }

  if (event.type !== 'session.execution.succeeded') return
  if (!shouldShowFooter({ events: facts, sessionId: sessionID })) return
  const model = sessionModel({ events: facts, sessionId: sessionID })
  if (!model) return
  const folder = path.basename(record.directory)
  const branch = await gitBranch(record.directory)
  const startedAt = lastExecutionStartedAt({ events: facts, sessionId: sessionID })
  const elapsed = Math.max(1, Math.round((Date.now() - (startedAt ?? Date.now())) / 1000))
  const pct = contextPercent({ events: facts, sessionId: sessionID }) ?? 0
  const mention = record.userId ? ` <@${record.userId}>` : ''
  await send(
    thread,
    `*${folder} ⋅ ${branch} ⋅ ${elapsed}s ⋅ ${pct}% ⋅ ${model.modelID}*${mention}`,
    NOTIFY,
    record.userId ? { parse: [], users: [record.userId] } : { parse: [] },
  )
}
