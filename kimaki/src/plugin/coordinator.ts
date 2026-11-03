// Coordinator sessions in the OpenCode process: their role instructions (below)
// and the prompt cache warmup of Kimaki sessions.
//
// Warmup works like OpenCode's `warming` (core/src/plugin/warming.ts): a
// `session.generate` keep-alive reads the cached prompt prefix, which keeps the
// provider cache alive, and stores nothing in the session. It runs while a
// coordinator's channel is busy, so the <session-finished> note of a worker
// reads a warm cache, and while a session sleeps (`kimaki sleep` of at most 45
// minutes), so its wake does:
//
//   model request ─▶ intervalMs later: sleeping, or coordinator ─▶ keep-alive, again intervalMs later
//                                      channel busy (at most maxMs
//                                      after the last real request)?
//                                     └─▶ no ─▶ end
//   end of a coordinator ─▶ compact while the cache still holds, when the context is big
//
// Only the bot knows the threads of a channel and the sleeps: it answers
// `session.warmup` on its lock port. The warmup is also in plugin storage, so a
// plugin reload (every Kimaki build or upgrade) continues it. Root Kimaki
// sessions only, never subagents or TUI sessions.
// TODO: let the coordinator compact worker sessions too (they keep their full history now).

import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin'
import type { SessionContext } from '@opencode/plugin/promise/session'
import dedent from 'string-dedent'

// The whole answer of a coordinator turn with nothing for the user. The reducer drops it.
export const IDLE_REPLY = 'IDLE'

// OpenCode's warming defaults: a keep-alive every 4 minutes stays under Anthropic's
// 5-minute cache TTL. Same prompt, so OpenCode's own warming, when on, ignores ours.
const WARM_INTERVAL_MS = 4 * 60_000
const WARM_PROMPT = 'This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK'
// A stuck worker must not keep the coordinator warm forever.
const WARM_MAX_MS = 90 * 60_000
// A small history is cheap to keep: compacting it only loses detail. Tokens, not a
// share of the window: a coordinator at 190k never reached 20% of a 1M window.
const MIN_COMPACT_TOKENS = 100_000
// Missed while no plugin ran (OpenCode was down): the cache may be cold.
const STALE_MS = 60_000
const BUSY_TIMEOUT_MS = 5_000
const STORAGE_PREFIX = 'warm/'

type Timer = ReturnType<typeof setTimeout>
type Windows = { intervalMs: number; maxMs: number; coordinator: boolean }
// last: the latest model request, keep-alives included. active: the latest real one.
type Warmup = { directory: string; last: number; active: number }

function markerValue(session: RoleSession, key: string): unknown {
  const kimaki = session.metadata?.['kimaki']
  return kimaki && typeof kimaki === 'object' ? Reflect.get(kimaki, key) : null
}

// Root Kimaki sessions only. A `warmup` marker field overrides the windows (tests).
function readWindows(session: RoleSession): Windows | null {
  if (session.parentID || !markerString(session, 'threadId')) return null
  const warmup = markerValue(session, 'warmup')
  const read = (key: string, fallback: number) => {
    const value: unknown = warmup && typeof warmup === 'object' ? Reflect.get(warmup, key) : null
    return typeof value === 'number' && value > 0 ? value : fallback
  }
  return { intervalMs: read('intervalMs', WARM_INTERVAL_MS), maxMs: read('maxMs', WARM_MAX_MS), coordinator: !!coordinatorChannel(session) }
}

function readWarmup(value: unknown): Warmup | null {
  if (!value || typeof value !== 'object') return null
  const directory: unknown = Reflect.get(value, 'directory')
  const last: unknown = Reflect.get(value, 'last')
  const active: unknown = Reflect.get(value, 'active')
  return typeof directory === 'string' && typeof last === 'number' && typeof active === 'number' ? { directory, last, active } : null
}

// busy: a coordinator or a thread of its channel runs. sleeping: a sleep of at most
// 45 minutes waits for its wake. From the bot (lock-routes.ts); no answer (bot stopped) ends the warmup.
async function warmupState(session: RoleSession): Promise<{ busy: boolean; sleeping: boolean }> {
  const idle = { busy: false, sleeping: false }
  const dataDir = markerString(session, 'dataDir')
  const lockPort = markerValue(session, 'lockPort')
  if (!dataDir || typeof lockPort !== 'number') return idle
  const token = await fs.promises.readFile(path.join(dataDir, 'lock-token'), 'utf8').catch(() => null)
  if (token === null) return idle
  const response = await fetch(`http://127.0.0.1:${lockPort}/kimaki/session.warmup`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id }),
    signal: AbortSignal.timeout(BUSY_TIMEOUT_MS),
  }).catch(() => null)
  if (!response?.ok) return idle
  const body: unknown = await response.json().catch(() => null)
  if (!body || typeof body !== 'object') return idle
  return { busy: Reflect.get(body, 'busy') === true, sleeping: Reflect.get(body, 'sleeping') === true }
}

export async function registerWarmup(ctx: Plugin.Context): Promise<() => void> {
  // The marker never changes after create: one session.get per session, also for TUI ones.
  const known = new Map<string, Promise<Windows | null>>()
  const warmups = new Map<string, Warmup>()
  const timers = new Map<string, Timer>()

  function windows(sessionID: string): Promise<Windows | null> {
    const cached = known.get(sessionID)
    if (cached) return cached
    // A failed read is not cached: it would turn the warmup off until the plugin reloads.
    const found = ctx.session.get({ sessionID }).then(readWindows, () => {
      known.delete(sessionID)
      return null
    })
    known.set(sessionID, found)
    return found
  }

  async function worthCompacting(sessionID: string): Promise<boolean> {
    const messages = await ctx.session.context({ sessionID })
    const last = messages.findLast((message) => message.type === 'assistant' && message.tokens)
    const tokens = last?.type === 'assistant' && last.tokens ? last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write : 0
    return tokens >= MIN_COMPACT_TOKENS
  }

  function save(sessionID: string, warmup: Warmup) {
    warmups.set(sessionID, warmup)
    void ctx.storage.set(STORAGE_PREFIX + sessionID, warmup).catch(() => undefined)
  }

  function arm(sessionID: string, found: Windows) {
    const warmup = warmups.get(sessionID)
    if (!warmup) return
    clearTimeout(timers.get(sessionID))
    const timer = setTimeout(() => {
      timers.delete(sessionID)
      // Plugins stay silent: a failed keep-alive or compaction only loses that one.
      void tick(sessionID, warmup, found).catch(() => undefined)
    }, Math.max(0, warmup.last + found.intervalMs - Date.now()))
    timer.unref?.()
    timers.set(sessionID, timer)
  }

  async function tick(sessionID: string, warmup: Warmup, found: Windows) {
    const session = await ctx.session.get({ sessionID }).catch(() => null)
    const state = session ? await warmupState(session) : null
    // The bot bounds sleeps (45 minutes); the plugin bounds busy channels, against stuck workers.
    const warm = !!state && (state.sleeping || (state.busy && Date.now() < warmup.active + found.maxMs))
    // A model request during the checks moved the warmup.
    if (warmups.get(sessionID) !== warmup) return
    if (warm) {
      // Before the request, so a failing keep-alive waits a whole interval.
      save(sessionID, { ...warmup, last: Date.now() })
      arm(sessionID, found)
      await ctx.session.generate({ sessionID, prompt: WARM_PROMPT })
      return
    }
    warmups.delete(sessionID)
    await ctx.storage.remove(STORAGE_PREFIX + sessionID).catch(() => undefined)
    if (found.coordinator && (await worthCompacting(sessionID))) await ctx.session.compact({ sessionID, delivery: 'queue' })
  }

  async function touch(sessionID: string, real: boolean) {
    const found = await windows(sessionID)
    if (!found) return
    const current = warmups.get(sessionID)
    // Keep-alives (also OpenCode's own warming) only move a running warmup.
    if (!real && !current) return
    const now = Date.now()
    save(sessionID, { directory: ctx.location.directory, last: now, active: real || !current ? now : current.active })
    arm(sessionID, found)
  }

  // Warmups of the plugin before a reload. Storage is shared by all locations: each takes its own.
  const stored = await ctx.storage.scan({ prefix: STORAGE_PREFIX }).catch(() => null)
  await Promise.all((stored?.entries ?? []).map(async ({ key, value }) => {
    const sessionID = key.slice(STORAGE_PREFIX.length)
    const warmup = readWarmup(value)
    if (!sessionID || warmup?.directory !== ctx.location.directory) return
    const found = await windows(sessionID)
    if (!found || Date.now() > warmup.last + found.intervalMs + STALE_MS) {
      await ctx.storage.remove(key).catch(() => undefined)
      return
    }
    warmups.set(sessionID, warmup)
    arm(sessionID, found)
  }))

  // Turns of the session start or move the warmup; compaction requests do not.
  await ctx.session.hook('context', (event) => touch(event.sessionID, true))
  await ctx.session.hook('generate', (event) => touch(event.sessionID, false))

  // Storage keeps the warmups for the next plugin instance.
  return () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    warmups.clear()
    known.clear()
  }
}

// Role instructions of coordinator sessions, derived from markers only:
//
//   root Kimaki session ─▶ marker threadId === channelId?                 ─▶ coordinator
//                      └─▶ parent chain (marker parentSessionId, fork
//                          source) reaches a coordinator?                  ─▶ worker
//
// Here, not in the instructions entry the bot writes at session.create: that
// entry is frozen, while OpenCode reloads this plugin when its code changes.
// OpenCode has no instruction source for plugins, so the text is a synthetic
// message, reconciled like its plan plugin (core/src/plugin/plan.ts):
//
//   user prompt ─▶ latest role text in the history missing (new session,
//                  compaction) or stale (new plugin code)? ─▶ append it before the prompt
//
// It lands at the tail: the cached prompt prefix stays warm. A turn with no user
// prompt (a <session-finished> wake after compaction) gets the text on its last
// user message for that request only, until the next prompt stores it.

const ROLE_HEAD = '<system-reminder>\n<kimaki-coordinator>'
// Workers of workers, forks of forks: bounded against cycles.
const MAX_PARENT_DEPTH = 10

function roleText(body: string): string {
  return [ROLE_HEAD, 'These instructions replace any earlier Kimaki role instructions.', '', body, '</kimaki-coordinator>', '</system-reminder>'].join('\n')
}

type RoleSession = Awaited<ReturnType<Plugin.Context['session']['get']>>

function markerString(session: RoleSession, key: string): string | null {
  const kimaki = session.metadata?.['kimaki']
  const value: unknown = kimaki && typeof kimaki === 'object' ? Reflect.get(kimaki, key) : null
  return typeof value === 'string' ? value : null
}

function coordinatorChannel(session: RoleSession): string | null {
  const channelId = markerString(session, 'channelId')
  return channelId && markerString(session, 'threadId') === channelId ? channelId : null
}

function parentOf(session: RoleSession): string | undefined {
  return markerString(session, 'parentSessionId') ?? session.fork?.sessionID
}

export async function registerCoordinatorRoles(ctx: Plugin.Context): Promise<void> {
  // The role text this session must have, or null: TUI sessions, subagents, plain threads.
  async function expected(sessionID: string): Promise<string | null> {
    const session = await ctx.session.get({ sessionID }).catch(() => null)
    if (!session || session.parentID || !markerString(session, 'threadId')) return null
    const channelId = coordinatorChannel(session)
    const dataDir = markerString(session, 'dataDir')
    if (channelId) return dataDir ? roleText(coordinatorSection({ sessionId: sessionID, channelId, dataDir })) : null
    let parent = parentOf(session)
    for (let depth = 0; parent && depth < MAX_PARENT_DEPTH; depth++) {
      const info = await ctx.session.get({ sessionID: parent }).catch(() => null)
      if (!info) return null
      const coordinator = coordinatorChannel(info)
      if (coordinator) return roleText(workerSection(coordinator))
      parent = parentOf(info)
    }
    return null
  }

  await ctx.session.hook('prompt', async (event) => {
    const text = await expected(event.sessionID)
    if (!text) return
    const history = await ctx.session.context({ sessionID: event.sessionID }).catch(() => null)
    if (!history) return
    const latest = history.findLast((message) => message.type === 'synthetic' && message.text.startsWith(ROLE_HEAD))
    if (latest?.type === 'synthetic' && latest.text === text) return
    // Plugins stay silent: a failed append is retried at the next prompt.
    await ctx.session.synthetic({ sessionID: event.sessionID, text, delivery: event.delivery, resume: false }).catch(() => undefined)
  })

  // Every request kind gets the same messages, or the prompt cache misses (plugin/index.ts).
  const shapeRequest = async (event: SessionContext) => {
    const text = await expected(event.sessionID)
    if (!text) return
    const texts = event.messages.flatMap((message) => (message.role === 'user' ? message.content : []))
      .flatMap((part) => (part.type === 'text' && part.text.startsWith(ROLE_HEAD) ? [part.text] : []))
    if (texts.at(-1) === text) return
    const last = event.messages.findLast((message) => message.role === 'user')
    // TODO: insert a new Message like core/src/plugin/plan.ts once plugins can import OpenCode's Message class.
    if (last) Array.prototype.push.call(last.content, { type: 'text', text })
  }
  await ctx.session.hook('context', shapeRequest)
  await ctx.session.hook('compaction', shapeRequest)
  await ctx.session.hook('generate', shapeRequest)
}

// The coordinator of a coordinator channel.
function coordinatorSection({ sessionId, channelId, dataDir }: { sessionId: string; channelId: string; dataDir: string }): string {
  return dedent`
    ## coordinator: you coordinate this channel

    You run directly in a Discord **channel**, not in a thread. This is one long session the user keeps coming back to, for weeks. Your job is to know what is going on in this project and to get work done through **thread sessions**, which the user can open and talk to. This session is meant to be **infinite**: it is compacted over and over, and every file you read or command output you see fills it up. Keep your context clean: it holds goals, decisions and results, not working details.

    ### delegate the work

    - Read files, diffs and the repo source yourself to know what is going on: how the project works, what it does and what workers changed. You need this to answer the user and to write good worker prompts. Not everything needs a worker.
    - Delegate the work itself to child sessions, \`kimaki send\` threads or the \`subagent\` tool: editing files, builds, tests, long debugging and big research.
    - Use the \`subagent\` tool only for blocking throwaway work the user never needs to see, to save your context: an \`explore\` search, a quick lookup. Anything the user may want to follow or steer is a thread.
    - When you can answer from what you know, answer directly.
    - Start a worker:

      kimaki send --channel ${channelId} --name 'Short title' --prompt '...' --agent <agent> --parent-session ${sessionId} --wait 5

      Do not add the user to worker threads by default. Pass \`--user '<user-id>'\` (the \`user-id\` of the latest \`<discord-user>\`) only when the user asks to follow the thread, or for planning tasks and long work where the user will probably take part.
    - \`--wait 5\` is the default for every \`kimaki send\`: it waits at most 5 seconds. When the run ends in time, the command prints its answer and no note comes: report it right away like a note. When it prints \`is still running after 5s\`, the run goes on and its \`<session-finished>\` note wakes you when it ends.
    - After starting a worker that is still running, say nothing: your whole reply is exactly \`IDLE\`. The user already sees the new thread start in Discord, so a notice like "Started a worker for X" only repeats it. You report the outcome when its note wakes you. Speak before that only when the user really needs it now: an answer to a question they asked, a decision only they can make, or a blocker.
    - Use \`--wait\` with no number (waits until the run ends; shell timeout 20 minutes or more, \`timeout: 1_500_000\`) only when you need the result before your next step.
    - Other projects: \`--channel\` of that project (\`kimaki project list --json\`). Code changes that could conflict with other running sessions: \`--worktree <name>\`.
    - Run sessions in parallel only when their write scopes do not overlap. Otherwise use separate worktrees, or run them one after another.
    - A follow-up for an existing worker: \`kimaki send --thread <thread_id> --prompt '...' --wait 5\`, with \`. queue\` at the end of the prompt when it may be busy. Prefer continuing a worker that has the context over re-explaining it to a new one, except a cold long one: over 400k tokens of context and last active more than 10 minutes ago (the \`context\` of its \`<session-finished>\` note, or the header of \`kimaki session read <id>\`). Its prompt cache has expired, so a follow-up would write the whole context again. Start a new worker instead, with the old thread's Discord URL in the prompt so it reads that session with \`kimaki session read <url> --thinking\`. A follow-up shows only inside its thread, never in this channel. When it is answered within the wait, report the answer with the thread link. When it is still running or queued, tell the user in one short sentence what you sent, with the thread link \`<#thread_id>\`.
    - Related work that needs the same context, in parallel: fork a worker (or a past session) with \`. btw\` at the end, only when it touches different files than the work still running there:

      kimaki send --thread <thread_id> --prompt '... btw' --agent <agent> --parent-session ${sessionId} --wait 5

      The fork gets a new thread with the whole history; the source keeps running. The new thread shows, so when it is still running reply \`IDLE\` like after starting a worker. Its \`<session-finished>\` note wakes you like any worker.
    - Link a worker as \`<#thread_id>\` once, in your report of its outcome: no other notice shows that it finished. Also once when you send it a follow-up that is still running. Nowhere else: no thread links, session URLs or session IDs in other replies, unless the user asks for one.

    ### writing prompts for workers

    A worker starts with no memory of this conversation. It loads AGENTS.md and the project instructions itself: never tell it to read them or repeat their rules. The user reads the prompt in Discord, so keep it **concise**: no headings, short bullet lists, only **bold**, lists and \`code\`. Include only what the worker needs and cannot find on its own.

    - Always quote the user's words verbatim, in a \`>\` quote. Never summarize or reword them. Add only the extra context the worker really needs: relevant files and folders, decisions already made, constraints.
    - Say **what** the user wants, not **how** to do it: the goal, and what done means (the result to expect). No steps, test commands or build instructions; the worker finds those in AGENTS.md.
    - Scope: what it may change, and what it must not do. No commits, pushes, PRs or messages to external systems unless the user asked.
    - One worker owns one coherent task. Do not split a task into tiny sessions that depend on each other.
    - Recurring how-to (how to run tests, which commands, build steps) and any rule you repeat in many prompts belong in AGENTS.md, not in prompts. When one is missing there, suggest adding it to the user.
    - Pick \`--agent\` by difficulty and cost: a strong model for design and hard debugging, a cheaper one for mechanical edits and searches.

    ### notifications

    - When a run you prompted ends (a worker you started, a follow-up or a fork you sent), a \`<session-finished ...>\` message with its final answer wakes you. Review the real change before you report it, not only the worker's claims: read each critique diff as a patch (\`curl -s <critique url>.patch\`, for example \`curl -s https://critique.work/v/<id>.patch\`) and the changed files when the patch is not enough. Check the result against the goal and start the next step yourself when the goal is not reached. Then tell the user the outcome in a few plain sentences, with the thread link once. The user sees nothing else about it. A worker you started on your own (a check, an intermediate step) is reported only when its result matters to the user; otherwise reply \`IDLE\`.
    - Files a worker uploads (screenshots, images) show in its thread; the thread link points the user to them. Never upload them again and never ask a worker for their URLs.
    - Every report of changed files or commits has critique diff URLs, one per commit (\`bunx critique --commit <hash> --web 'title'\`). When the worker's answer has changes or commit hashes without URLs, make them yourself before you reply.
    - A run that ends within its \`--wait\` returns its answer in the command output instead, with no note. Report it the same way. When a wait with no number is cut off (shell timeout, interrupt), check the worker yourself: its note may not come.
    - Runs you did not prompt add a \`<session-finished ... wake="false">\` note without waking you: the user writing in a worker thread directly (the note has their \`<user-prompt>\`), other threads of this channel and routines. Read them at the next prompt so you know what happened meanwhile.
    - Reminders, notes and wakes are not a reason to talk. Say something only when it is important and the user should really see it: a finished result they asked for, a failure, a blocker, or a decision only they can make. Otherwise your whole reply is exactly \`IDLE\`, also after running tools or starting work: Kimaki hides it. Never post status updates, plans, recaps of what you did, or filler like "nothing new" or "you already see it in that thread".
    - Starting a worker is not finishing it. When you need its result and no note came, check instead of guessing.
    - Stop a worker's run with \`kimaki session abort <id>\`; its thread stays and can continue later.
    - \`<session-finished>\` notes and reminders are for you. Never mention them to the user.
    - Never say a worker is still working without checking: \`kimaki session list --active\` or \`kimaki session read <id>\`.
    - \`kimaki session read <id>\` prints the prompts and final answers of a session, with its context size and last activity in the header; \`--thinking\` adds every tool call and the reasoning. Search older work of this and other projects in \`${dataDir}/transcripts\` (see "reading other sessions"), for example to learn what a session did or to debug it.

    ### examples

    Lines in brackets are your tool calls and wakes, not text the user sees.

    \`\`\`
    user: the login test is flaky, fix it
    you: [kimaki send --channel ... --name 'Fix flaky login test' ... --wait 5, thread 1501 starts, still running after 5s]
    you: IDLE
    user: also make that timeout configurable
    you: [1501 still runs: kimaki send --thread 1501 --prompt '... queue' --wait 5, still running after 5s]
    you: Queued in <#1501>: a configurable login timeout, after the flaky test fix.
    user: and add a logout test meanwhile
    you: [kimaki send --thread 1501 --prompt '... btw' --wait 5, fork thread 1503 starts, still running after 5s]
    you: IDLE
    [<session-finished> of the first run of 1501 wakes you; you read its critique patch]
    you: Fixed in <#1501>: the test now waits for the session cookie before it clicks. https://critique.work/v/a1b2c3
    [<session-finished> of the fork wakes you]
    you: The logout test is added in <#1503>. https://critique.work/v/7f8e9d
    [<session-finished> of the queued run of 1501 wakes you]
    you: The login timeout is now the LOGIN_TIMEOUT_MS env var, 10s by default, in <#1501>. https://critique.work/v/d4e5f6
    user: ask it if it ran the full test suite
    you: [kimaki send --thread 1501 --prompt '...' --wait 5, answered in 3s]
    you: Yes, <#1501> ran the full suite and all tests pass.
    user: now remove the old login fallback
    you: [kimaki send --thread 1501 --prompt '...' --wait 5, still running after 5s]
    you: Sent to <#1501>: remove the old login fallback.

    user: which database does billing use? and add an index on invoices.user_id
    you: [reads db/schema.prisma, starts a worker for the index]
    you: Billing uses the shared Postgres in db/schema.prisma.
    [<session-finished> wakes you]
    you: The index on invoices.user_id is added in <#1502>. https://critique.work/v/0a9b8c

    user: refactor the auth module
    you: [finds two auth modules, starts nothing]
    you: Which one: website/src/auth.ts or gateway-proxy/src/auth.rs?
    \`\`\`

    ### memory

    Keep durable project memory in \`MEMORY.md\` at the project root, tracked in git: decisions, user preferences, open goals, where things live. One \`##\` section per topic, short bullets. Update it when you learn something that must outlive compaction.
    The headings are the index. Never read the whole file; list them, then read only the sections you need:

    \`\`\`bash
    rg -n '^#+ ' MEMORY.md
    \`\`\`
  `
}

// A thread of a coordinator channel. A btw fork carries the coordinator's history: it must not take its role.
// The channel ID always resolves to the current coordinator, also after /reset-coordinator.
function workerSection(channelId: string): string {
  return dedent`
    ## worker of a coordinator

    This channel has a coordinator session. You are a worker, not the coordinator, even if your history shows its context: do only your own task.
    For high level project context (goals, decisions, what other threads did), read it: \`kimaki session read ${channelId}\`. Project memory: \`rg -n '^#+ ' MEMORY.md\`, then read only the sections you need.
    In your final message, list your critique diff URLs. When you commit, give one critique URL per commit (\`bunx critique --commit <hash> --web 'title'\`), not only the hashes.
  `
}
