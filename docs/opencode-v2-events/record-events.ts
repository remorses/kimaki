// Records real OpenCode V2 event streams as fixtures for the kimaki rebuild (docs/kimaki-v2-rebuild-spec.md section 28).
// Needs a running `opencode serve` (@opencode/cli 2.0.19) and @opencode/client in node_modules. Run:
// OC_URL=http://127.0.0.1:47821 OC_PASSWORD=pw123 OC_DIR=<git project> bun record-events.ts <outDir> [scenario...]
import fs from 'node:fs'
import path from 'node:path'
import { OpenCode } from '@opencode/client'

const baseUrl = process.env.OC_URL || 'http://127.0.0.1:47821'
const password = process.env.OC_PASSWORD || 'pw123'
const directory = process.env.OC_DIR!
const outDir = process.argv[2]!
const only = process.argv.slice(3)
const model = { providerID: 'openai', id: 'gpt-6-luna', variant: 'low' }
const location = { directory }

const client = OpenCode.make({
  baseUrl,
  headers: {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    'x-opencode-directory': directory,
  },
})

fs.mkdirSync(outDir, { recursive: true })
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args)

type Ev = { type: string; data?: any; [k: string]: any }
const allEvents: Array<{ at: number; scenario: string; event: Ev }> = []
let currentScenario = 'setup'
const listeners = new Set<(e: Ev) => void>()
const allFile = fs.createWriteStream(path.join(outDir, 'all-events.jsonl'), { flags: 'a' })

const abort = new AbortController()
void (async () => {
  for await (const event of client.event.subscribe({ signal: abort.signal }) as AsyncIterable<Ev>) {
    const entry = { at: Date.now(), scenario: currentScenario, event }
    allEvents.push(entry)
    allFile.write(JSON.stringify(entry) + '\n')
    for (const l of listeners) l(event)
  }
})().catch((e) => log('event stream ended', e?.message))

function sessionOf(e: Ev): string | undefined {
  return e.data?.sessionID ?? e.data?.session?.id ?? e.data?.info?.sessionID ?? e.data?.request?.sessionID ?? e.data?.form?.sessionID
}

function waitForEvent(pred: (e: Ev) => boolean, timeoutMs: number, label: string): Promise<Ev> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      listeners.delete(l)
      reject(new Error(`timeout waiting for ${label}`))
    }, timeoutMs)
    const l = (e: Ev) => {
      if (!pred(e)) return
      clearTimeout(t)
      listeners.delete(l)
      resolve(e)
    }
    listeners.add(l)
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitIdle(sessionID: string, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs
  await sleep(800)
  while (Date.now() < deadline) {
    const active = await client.session.active()
    const data = (active as any).data ?? active
    if (!data[sessionID]) return
    await sleep(500)
  }
  throw new Error(`session ${sessionID} still active after ${timeoutMs}ms`)
}

async function create(title: string, extra: Record<string, unknown> = {}) {
  const s: any = await client.session.create({ title, model, location, ...extra } as any)
  log('created session', s.id, title)
  return s.id as string
}

async function prompt(sessionID: string, text: string, extra: Record<string, unknown> = {}) {
  log('prompt', sessionID, JSON.stringify(text.slice(0, 60)), JSON.stringify(extra))
  return client.session.prompt({ sessionID, text, ...extra } as any)
}

async function dumpLog(name: string, sessionID: string) {
  const file = fs.createWriteStream(path.join(outDir, `${name}.session-log.${sessionID}.jsonl`))
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 5000)
  try {
    for await (const item of (client.session.log({ sessionID }, { signal: ac.signal } as any) as any)) {
      file.write(JSON.stringify(item) + '\n')
    }
  } catch (e: any) {
    if (!ac.signal.aborted) log('log dump error', e?.message)
  } finally {
    clearTimeout(timer)
    file.end()
  }
}

function writeScenario(name: string, roots: string[]) {
  const sessions = new Set(roots)
  // discover children via task tool progress metadata and session.created parentID
  for (const { event } of allEvents) {
    const child = event.data?.metadata?.sessionID
    if (event.type === 'session.tool.progress' && child && sessions.has(event.data.sessionID)) sessions.add(child)
    const parent = event.data?.parentID ?? event.data?.session?.parentID ?? event.data?.info?.parentID
    const sid = sessionOf(event)
    if (parent && sid && sessions.has(parent)) sessions.add(sid)
  }
  const rows = allEvents.filter(({ scenario, event }) => {
    if (scenario !== name) return false
    const sid = sessionOf(event)
    return !sid || sessions.has(sid)
  })
  fs.writeFileSync(
    path.join(outDir, `${name}.events.jsonl`),
    rows.map((r) => JSON.stringify({ at: r.at, event: r.event })).join('\n') + '\n',
  )
  log(`wrote ${name}: ${rows.length} events, sessions=${[...sessions].join(',')}`)
  return [...sessions]
}

const scenarios: Record<string, () => Promise<string[]>> = {
  // task tool with explore subagent + read/grep tools
  async 'task-subagent'() {
    const id = await create('task subagent')
    await prompt(id, 'Use the subagent tool with agent "general" to find which file defines the Drizzle SQLite schema in cli/src (the subagent should use glob and read). Then read the first 10 lines of that file yourself with the read tool and answer in 2 short sentences.')
    await waitIdle(id)
    return [id]
  },
  // two parallel subagents in one step
  async 'task-parallel'() {
    const id = await create('parallel subagents')
    await prompt(id, 'In a single step, call the subagent tool twice in parallel, both with agent "general": one to count the .ts files in cli/src/commands using a shell command, one to list the top-level folders of the repo with a shell command. Then reply with both results in 2 lines.')
    await waitIdle(id)
    return [id]
  },
  // bash, write, edit, read, glob
  async tools() {
    const id = await create('tools')
    await prompt(id, 'Do these steps with tools, one by one: 1) run `ls cli/src | head -5` with bash, 2) write a file tmp-events/hello.txt containing "hello", 3) edit that file to replace hello with "hello world", 4) glob for **/*.txt under tmp-events, 5) read the file. Then reply with one short line.')
    await waitIdle(id)
    return [id]
  },
  // question tool → form events; answer with form.reply
  async question() {
    const id = await create('question')
    const formP = waitForEvent((e) => e.type === 'form.created' && sessionOf(e) === id, 120_000, 'form.created')
    await prompt(id, 'Use the question tool to ask me which color I prefer, with options red, green, blue (single choice), and in the same question tool call add a second question asking which fruits I like with options apple, pear, kiwi (multiple choice). After my answer, reply with one line.')
    const form: any = await formP
    log('form', JSON.stringify(form.data).slice(0, 400))
    const fields: any[] = form.data?.form?.fields ?? form.data?.fields ?? []
    const answer: Record<string, any> = {}
    for (const f of fields) answer[f.id ?? f.key] = f.type === 'multiselect' ? ['apple', 'kiwi'] : 'green'
    if (fields.length === 0) answer.q0 = 'green'
    await client.session.form.reply({ sessionID: id, formID: form.data?.form?.id ?? form.data?.id, answer } as any)
    await waitIdle(id)
    return [id]
  },
  // permission ask for bash → reply once, then reject a second
  async permission() {
    const id = await create('permission', {
      permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
    })
    const p1 = waitForEvent((e) => e.type === 'permission.asked' && sessionOf(e) === id, 120_000, 'permission 1')
    await prompt(id, 'Run `echo first` with bash. Then run `echo second` with bash. Then reply with one line describing what happened.')
    const a1: any = await p1
    log('permission', JSON.stringify(a1.data).slice(0, 300))
    const p2 = waitForEvent((e) => e.type === 'permission.asked' && sessionOf(e) === id, 120_000, 'permission 2')
    await client.permission.reply({ sessionID: id, requestID: a1.data?.id ?? a1.data?.request?.id, decision: 'once' } as any)
    const a2: any = await p2.catch(() => null)
    if (a2) await client.permission.reply({ sessionID: id, requestID: a2.data?.id ?? a2.data?.request?.id, decision: 'reject', message: 'not now' } as any)
    await waitIdle(id)
    return [id]
  },
  // steer while busy (interrupt resume) and queue while busy, cancel one queued item
  async 'steer-queue'() {
    const id = await create('steer and queue')
    await prompt(id, 'Run `sleep 8 && echo slow-done` with bash, then say done.')
    await waitForEvent((e) => e.type === 'session.tool.called' && sessionOf(e) === id, 90_000, 'first tool call')
    await prompt(id, 'QUEUED-A: after everything, reply with the word apple.', { delivery: 'queue' })
    await prompt(id, 'QUEUED-B: reply with the word banana.', { delivery: 'queue', id: 'msg_kimaki_queued_b_test1' })
    await prompt(id, 'QUEUED-C: reply with the word cherry.', { delivery: 'queue' })
    await sleep(300)
    const inbox: any = await client.session.inbox.list({ sessionID: id })
    log('inbox', JSON.stringify(inbox).slice(0, 500))
    await client.session.inbox.cancel({ sessionID: id, inboxID: 'msg_kimaki_queued_b_test1' } as any)
    await prompt(id, 'STEER: actually also tell me the current date using bash `date`.', { delivery: 'steer' })
    const r: any = await client.session.interrupt({ sessionID: id, resume: true })
    log('interrupt resume', JSON.stringify(r))
    await waitIdle(id, 300_000)
    return [id]
  },
  // queue while busy without any interrupt: does the queue drain at the end?
  async 'queue-plain'() {
    const id = await create('queue plain')
    await prompt(id, 'Run `sleep 6 && echo slow-done` with bash, then say done.')
    await waitForEvent((e) => e.type === 'session.tool.called' && sessionOf(e) === id, 90_000, 'first tool call')
    await prompt(id, 'QUEUED-1: reply with the word apple.', { delivery: 'queue' })
    await prompt(id, 'QUEUED-2: reply with the word cherry.', { delivery: 'queue' })
    await waitIdle(id, 300_000)
    await sleep(3000)
    await waitIdle(id, 300_000)
    const inbox: any = await client.session.inbox.list({ sessionID: id })
    log('inbox after idle', JSON.stringify(inbox).slice(0, 300))
    return [id]
  },
  // items parked by interrupt: does a later prompt or inbox.update wake them?
  async 'queue-parked'() {
    const id = await create('queue parked')
    await prompt(id, 'Run `sleep 6 && echo slow-done` with bash, then say done.')
    await waitForEvent((e) => e.type === 'session.tool.called' && sessionOf(e) === id, 90_000, 'first tool call')
    await prompt(id, 'PARKED-1: reply with the word apple.', { delivery: 'queue' })
    await client.session.interrupt({ sessionID: id, resume: false })
    await waitIdle(id)
    const inbox1: any = await client.session.inbox.list({ sessionID: id })
    log('inbox after interrupt', JSON.stringify(inbox1).slice(0, 300))
    await prompt(id, 'NEW: reply with the word kiwi.')
    await waitIdle(id)
    await sleep(3000)
    await waitIdle(id)
    const inbox2: any = await client.session.inbox.list({ sessionID: id })
    log('inbox after new prompt', JSON.stringify(inbox2).slice(0, 300))
    return [id]
  },
  // abort while running a tool, no resume
  async abort() {
    const id = await create('abort')
    await prompt(id, 'Run `sleep 30 && echo never` with bash, then summarize.')
    await waitForEvent((e) => e.type === 'session.tool.called' && sessionOf(e) === id, 90_000, 'tool call')
    await sleep(1500)
    const r: any = await client.session.interrupt({ sessionID: id, resume: false })
    log('interrupt', JSON.stringify(r))
    await waitIdle(id)
    await prompt(id, 'Say only: resumed after abort.')
    await waitIdle(id)
    return [id]
  },
  // user shell while idle and while busy, and a no-reply prompt
  async shell() {
    const id = await create('shell')
    await client.session.shell({ sessionID: id, command: 'echo user-shell-idle && git log --oneline -1' } as any)
    await sleep(1000)
    await prompt(id, 'CONTEXT ONLY: the deploy tag is v9.9.9', { resume: false })
    await sleep(500)
    await prompt(id, 'What did my shell command print, and what is the deploy tag? Also run `sleep 5` with bash first.')
    await waitForEvent((e) => e.type === 'session.tool.called' && sessionOf(e) === id, 90_000, 'tool call')
    await client.session.shell({ sessionID: id, command: 'echo user-shell-busy' } as any)
    await waitIdle(id)
    return [id]
  },
  // fork a finished session and continue in the fork; compact the fork
  async 'fork-compact'() {
    const id = await create('fork source')
    await prompt(id, 'Remember the secret word: mango. Reply with ok.')
    await waitIdle(id)
    const fork: any = await client.session.fork({ sessionID: id })
    const forkID = fork.id ?? fork.data?.id
    log('fork', forkID)
    await prompt(forkID, 'What was the secret word? One word.')
    await waitIdle(forkID)
    await client.session.compact({ sessionID: forkID } as any)
    await waitIdle(forkID)
    return [id, forkID]
  },
  // worktree create + session in the worktree location
  async worktree() {
    const loc: any = await client.location.get({ location } as any)
    log('location', JSON.stringify(loc))
    const wt: any = await client.worktree.create({ projectID: loc.project?.id ?? loc.data?.project?.id, name: 'events-wt' } as any)
    log('worktree', JSON.stringify(wt))
    const wtDir = wt.directory ?? wt.data?.directory
    const s: any = await client.session.create({ title: 'worktree', model, location: { directory: wtDir } } as any)
    await prompt(s.id, 'Run `git branch --show-current && pwd` with bash and reply with the output.')
    await waitIdle(s.id)
    return [s.id]
  },
  // model switch + agent switch mid session, rename
  async 'switch-model'() {
    const id = await create('switch model')
    await prompt(id, 'Reply with the word one.')
    await waitIdle(id)
    await client.session.switchModel({ sessionID: id, model: { providerID: 'openai', id: 'gpt-6-luna', variant: 'medium' } } as any)
    await client.session.switchAgent({ sessionID: id, agent: 'plan' } as any).catch((e: any) => log('switchAgent failed', e?.message))
    await client.session.update({ sessionID: id, title: 'renamed by script' } as any).catch((e: any) => log('update failed', e?.message))
    await prompt(id, 'Reply with the word two.')
    await waitIdle(id)
    return [id]
  },
}

for (const [name, run] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue
  currentScenario = name
  log(`=== scenario ${name}`)
  const roots = await run().catch((e) => {
    log(`scenario ${name} failed:`, e?.message)
    return [] as string[]
  })
  await sleep(1500)
  const sessions = writeScenario(name, roots)
  for (const sid of sessions) await dumpLog(name, sid)
}

abort.abort()
allFile.end()
log('done')
process.exit(0)
