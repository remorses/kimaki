// AI SDK language model for one Grok Bot. A model ID is a bot (or group) slug, see bots.ts.
//
// One OpenCode turn = one prompt to the bot:
//
//   doStream ──▶ baseline transcript tail ──▶ answer a pending card, or sendPrompt (clientNonce)
//            ──▶ /events + tail and roster every second ──▶ entries of our requestId, activity
//            ──▶ stream parts ──▶ finish when lastTurnSettlement names our requestId
//
// The bot keeps its own memory and history, so only the new user text is sent.
// OpenCode's system prompt and tools are not used: the bot runs its own.

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Prompt, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from '@ai-sdk/provider'
import * as errore from 'errore'
import { GrokBotAbortError, GrokBotGatewayError, type Agent, type GrokBotClient } from './grok-bot.ts'
import { cardAnswer, createActivityTracker, createTurnConverter, isFromUser, pendingCard, type Entry } from './transcript.ts'

export const PROVIDER_ID = 'grok-bot'
export const KIND_HEADER = 'x-grok-bot-kind'
// OpenCode sets this on every model request of a session.
const SESSION_HEADER = 'x-opencode-session-id'

const TAIL_LIMIT = 60
const POLL_INTERVAL_MS = 1_000
// The roster turns idle a moment before the last message lands (see GrokBotCLI daemon/hub.go).
const IDLE_CHECKS_TO_FINISH = 2
// A bot that never reports activity or output still ends the turn after this.
const NO_OUTPUT_TIMEOUT_MS = 120_000

export class GrokBotTurnError extends errore.createTaggedError({
  name: 'GrokBotTurnError',
  message: 'Grok Bot turn failed: $reason',
}) {}

type TranscriptPage = { entries?: Entry[] } | Entry[] | null

function pageEntries(page: TranscriptPage) {
  if (Array.isArray(page)) return page
  return page?.entries ?? []
}

// The user text OpenCode added since the bot's last answer.
export function latestUserText(prompt: LanguageModelV3Prompt) {
  const lastAssistant = prompt.findLastIndex((message) => message.role === 'assistant')
  return prompt
    .slice(lastAssistant + 1)
    .flatMap((message) => (message.role === 'user' ? message.content : []))
    .flatMap((part) => (part.type === 'text' ? [part.text] : [`(attachment ${part.filename ?? part.mediaType} not sent: Grok Bot attachments are not supported yet)`]))
    .join('\n\n')
    .trim()
}

function agentBusy(agent: Agent | undefined) {
  if (!agent) return false
  return agent.isRunning === true || agent.isRunningTurn === true
}

function awaitingUser(agent: Agent | undefined) {
  const value = agent?.awaitingUserResponse
  return value !== undefined && value !== null && value !== false
}

function sleep({ ms, signal }: { ms: number; signal: AbortSignal }) {
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

type TranscriptEvent = { type?: string; agentId?: string; entry?: Entry }
type UpsertEvent = { agent?: Agent }

function findAgent(agents: Agent[] | { agents?: Agent[] } | null, agentId: string) {
  return (Array.isArray(agents) ? agents : (agents?.agents ?? [])).find((candidate) => candidate.id === agentId)
}

function maxSeq(entries: Entry[]) {
  return entries.reduce((max, entry) => (typeof entry.seq === 'number' && entry.seq > max ? entry.seq : max), 0)
}

// `since` is the last transcript seq the session showed; entries the bot wrote after it (a
// background task, a routine, a reply hours later) are shown before this turn's answer.
// `seen` receives the new last seq when the turn ends.
export async function runTurn({
  client,
  agentId,
  text,
  since,
  seen,
  emit,
  signal,
}: {
  client: GrokBotClient
  agentId: string
  text: string
  since: number | null
  seen: (seq: number) => void
  emit: (part: LanguageModelV3StreamPart) => void
  signal: AbortSignal
}) {
  const convert = createTurnConverter()
  const nonce = crypto.randomUUID()
  // Tool call IDs must be unique in the session, so they carry this turn's nonce.
  const activity = createActivityTracker({ prefix: `activity-${nonce}` })
  const [tail, roster] = await Promise.all([
    client.call<TranscriptPage>({ method: 'getAgentTranscriptTail', body: { id: agentId, limit: TAIL_LIMIT }, signal }),
    client.call<Agent[] | { agents?: Agent[] }>({ method: 'listAgents', body: {}, signal }),
  ])
  if (tail instanceof Error) return tail
  if (roster instanceof Error) return roster
  const before = new Set(pageEntries(tail).map((entry) => entry.id))
  let lastSeq = maxSeq(pageEntries(tail))
  const missed = since === null ? [] : pageEntries(tail).filter((entry) => typeof entry.seq === 'number' && entry.seq > since && !isFromUser(entry))
  if (missed.length > 0) {
    const parts = [{ id: `missed-${nonce}`, kind: 'notice', text: 'Sent by the bot since the last message:' } satisfies Entry, ...missed].flatMap(convert.push)
    for (const part of [...parts, ...convert.end()]) emit(part)
  }
  // A settlement seen before sending belongs to an earlier turn, even with the same requestId.
  const previousSettlement = findAgent(roster, agentId)?.lastTurnSettlement?.settledAtMs
  // An OpenCode reply to a pending card answers it, like clicking it in the app.
  const card = pageEntries(tail).findLast((entry) => pendingCard(entry) !== null)
  const answer = card ? cardAnswer({ entry: card, agentId, reply: text }) : null
  // The bot's turn ID: the `requestId` of our prompt entry, also on every entry of the turn.
  // Answering a card resumes the card's turn.
  let requestId = answer && typeof card?.requestId === 'string' ? card.requestId : undefined
  let settled: { outcome?: string } | undefined
  let agent: Agent | undefined

  const apply = (entry: Entry) => {
    if (before.has(entry.id)) return
    if (entry.clientNonce === nonce && typeof entry.requestId === 'string') requestId = entry.requestId
    // Entries of other turns (a routine, another device) are not part of this answer. Until our
    // prompt shows up they wait; the next tail poll brings them again.
    if (entry.requestId !== undefined && entry.requestId !== requestId) return
    for (const part of convert.push(entry)) emit(part)
  }
  const observe = (next: Agent | undefined) => {
    if (!next) return
    agent = next
    for (const part of activity.update(next.currentActivity)) emit(part)
    const settlement = next.lastTurnSettlement
    if (requestId && settlement?.clientNonce === requestId && settlement.settledAtMs !== previousSettlement) settled = settlement
  }
  const pollTail = async () => {
    const entries = await client.call<TranscriptPage>({ method: 'getAgentTranscriptTail', body: { id: agentId, limit: TAIL_LIMIT }, signal })
    // A failed poll is retried on the next tick; the turn only fails on abort.
    if (entries instanceof Error) return entries
    pageEntries(entries).forEach(apply)
    lastSeq = Math.max(lastSeq, maxSeq(pageEntries(entries)))
    return entries
  }

  // Events make text and tool activity live; the poll below repairs anything they missed.
  const stop = new AbortController()
  const watchSignal = AbortSignal.any([signal, stop.signal])
  const watch = (async () => {
    while (!watchSignal.aborted) {
      const events = client.events({ signal: watchSignal })
      while (true) {
        const next = await events.next()
        if (next.done) break
        const { channel, payload } = next.value
        if (channel === 'transcript') {
          const event = payload as TranscriptEvent
          if (event.agentId === agentId && event.entry && (event.type === 'appended' || event.type === 'updated')) apply(event.entry)
        }
        if (channel === 'agent-upserted') {
          const event = payload as UpsertEvent
          if (event.agent?.id === agentId) observe(event.agent)
        }
      }
      await sleep({ ms: POLL_INTERVAL_MS, signal: watchSignal })
    }
  })()
  const finish = async () => {
    stop.abort()
    await watch
    for (const part of [...convert.end(), ...activity.end()]) emit(part)
  }

  const sent = answer
    ? await client.call({ method: answer.method, body: answer.body, signal })
    : await client.call<{ accepted?: boolean } | null>({
        method: 'sendPrompt',
        body: { agentId, prompt: text, clientNonce: nonce, directAddressedAcceptance: true, source: 'desktop', sendSource: 'chat', initiator: 'user', composedAtMs: Date.now() },
        signal,
      })
  // An abort while sending may still have delivered the prompt, so it interrupts the bot below.
  if (sent instanceof Error && !errore.isAbortError(sent)) {
    await finish()
    return sent
  }
  if (!answer && sent && !(sent instanceof Error) && typeof sent === 'object' && 'accepted' in sent && sent.accepted === false) {
    await finish()
    return new GrokBotTurnError({ reason: 'the bot did not accept the message. Check the bot in the Grok Bot app' })
  }

  const started = Date.now()
  let idleChecks = 0
  let sawBusy = false
  while (!signal.aborted && !settled && !errore.isAbortError(sent)) {
    await sleep({ ms: POLL_INTERVAL_MS, signal })
    if (signal.aborted) break
    const [entries, agents] = await Promise.all([pollTail(), client.call<Agent[] | { agents?: Agent[] }>({ method: 'listAgents', body: {}, signal })])
    if (errore.isAbortError(entries) || errore.isAbortError(agents)) break
    if (!(agents instanceof Error)) observe(findAgent(agents, agentId))
    sawBusy ||= agentBusy(agent)
    // Fallbacks when no settlement names our turn: a card answer that ran, a bot waiting for the user.
    const idle = !agentBusy(agent) && ((sawBusy && (answer !== null || awaitingUser(agent))) || Date.now() - started > NO_OUTPUT_TIMEOUT_MS)
    idleChecks = idle ? idleChecks + 1 : 0
    if (idleChecks >= IDLE_CHECKS_TO_FINISH) break
  }
  // The settlement can arrive (over events) before the last messages were read.
  const last = signal.aborted ? null : await pollTail()
  if (last instanceof Error) console.warn(`[grok-bot] last transcript read failed: ${last.message}`)
  await finish()
  seen(lastSeq)
  if (signal.aborted || errore.isAbortError(sent)) {
    // Interrupt the bot only when OpenCode stopped the turn, not when it finished.
    await client.call({ method: 'interruptAgentRun', body: { id: agentId }, signal: AbortSignal.timeout(POLL_INTERVAL_MS * 10) })
    return new GrokBotAbortError({ cause: signal.reason })
  }
  if (settled && settled.outcome !== 'success') return new GrokBotTurnError({ reason: `the bot ended the turn with outcome "${settled.outcome}"` })
  return null
}

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
}

export class GrokBotLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3'
  readonly provider = PROVIDER_ID
  readonly supportedUrls = {}

  // `modelId` is a bot slug (bots.ts); `resolveBot` turns it into the bot ID on every turn.
  constructor(
    readonly modelId: string,
    readonly client: GrokBotClient,
    readonly resolveBot: (input: { slug: string; signal: AbortSignal }) => Promise<string | Error>,
    // Last transcript seq each session showed, per bot (plugin storage).
    readonly cursor: { get: (key: string) => Promise<number | null>; set: (key: string, seq: number) => Promise<void> },
  ) {}

  async doGenerate(): Promise<never> {
    throw new Error('Grok Bot models only support streaming')
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const abort = new AbortController()
    const signal = options.abortSignal ? AbortSignal.any([abort.signal, options.abortSignal]) : abort.signal
    const kind = options.headers?.[KIND_HEADER]
    const text = latestUserText(options.prompt)
    const client = this.client
    const slug = this.modelId
    const resolveBot = this.resolveBot
    const cursor = this.cursor
    const sessionID = options.headers?.[SESSION_HEADER]
    let closed = false
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        const emit = (part: LanguageModelV3StreamPart) => {
          if (!closed) controller.enqueue(part)
        }
        const finish = (error: Error | null) => {
          if (closed) return
          if (error && !errore.isAbortError(error)) emit({ type: 'error', error })
          if (!error) emit({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE })
          closed = true
          controller.close()
        }
        // Titles and summaries never reach the bot: the plugin answers them (see index.ts).
        if (kind && kind !== 'primary') {
          finish(new GrokBotTurnError({ reason: `${kind} requests are not supported by Grok Bot models` }))
          return
        }
        if (!text) {
          finish(new GrokBotTurnError({ reason: 'the message has no text to send' }))
          return
        }
        const turn = async () => {
          const agentId = await resolveBot({ slug, signal })
          if (agentId instanceof Error) return agentId
          const key = sessionID ? `${sessionID}/${agentId}` : null
          const since = key ? await cursor.get(key) : null
          const seen = (seq: number) => {
            if (key) void cursor.set(key, seq).catch((cause) => console.warn('[grok-bot] could not save the transcript position', cause))
          }
          return runTurn({ client, agentId, text, since, seen, emit, signal })
        }
        void turn().then(finish, (cause) => finish(new GrokBotGatewayError({ method: 'turn', reason: 'unexpected failure', cause })))
      },
      cancel: () => {
        closed = true
        abort.abort()
      },
    })
    return { stream }
  }
}
