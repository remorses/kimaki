// The bot API behind the lock port: one typed route per CLI or agent call.
// `kimaki <cmd>` ─▶ callBot(name, input) ─▶ POST /kimaki/<name> ─▶ runLockRoute
//   ─▶ zod input schema ─▶ run(bot, input, signal) ─▶ JSON { data } or { error }
// The CLI imports only types from here, so it never loads bot code for the table.

import fs from 'node:fs'
import inspector from 'node:inspector/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import v8 from 'node:v8'
import * as errore from 'errore'
import * as orm from 'drizzle-orm'
import { z } from 'zod'

import { parseButton } from './agent-ui.ts'
import { fetchThread, oc, parseModel, projectOf, type Bot } from './bot.ts'
import { credential, loginCli } from './commands/login-commands.ts'
import { setChannelAgent, setChannelModel, setVerbosity } from './commands/preference-commands.ts'
import { channelWorktrees, manageWorktree, newWorktree, setAutoWorktrees } from './commands/worktree-commands.ts'
import { ConfigError, DbError, DiscordError, FilesystemError, OpenCodeUnavailableError } from './errors.ts'
import { RESTART_EXIT_CODE } from './lock-server.ts'
import { abort, cancelQueuedPrompt, clearQueue, send, shell, upload } from './prompt.ts'
import { createTask, deleteTask, editTask, runTaskNow } from './scheduler.ts'
import * as schema from './schema.ts'
import { channelForDirectory, channelForSession, fork, resume, sessionCwd } from './sessions.ts'
import { createSleep } from './sleeps.ts'
import { worktreeName } from './worktrees.ts'

type LockRoute<S extends z.ZodType, R> = {
  input: S
  run: (bot: Bot, input: z.output<S>, signal: AbortSignal) => Promise<Error | R>
}

// Keeps input and run correlated, and gives the dispatcher one untyped entry point.
function route<S extends z.ZodType, R>(definition: LockRoute<S, R>) {
  return {
    ...definition,
    handle: async (bot: Bot, raw: unknown, signal: AbortSignal): Promise<Error | { data: unknown }> => {
      const input = parseInput(definition.input, raw)
      if (input instanceof Error) return input
      const result = await definition.run(bot, input, signal)
      if (result instanceof Error) return result
      return { data: result }
    },
  }
}

// The first issue is the user-facing reason: every schema below sets its own messages.
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): ConfigError | z.output<S> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  return new ConfigError({ reason: parsed.error.issues[0]?.message ?? 'Invalid input' })
}

const text = (key: string) => {
  const message = `${key} must be a non-empty string`
  return z.string({ error: message }).refine((value) => value.trim() !== '', { error: message })
}

// Typed as string for the CLI, which passes user text through; the bot checks the value.
const oneOf = <const T extends readonly [string, ...string[]]>(values: T, error: string) =>
  z.string({ error }).pipe(z.enum(values, { error }))

const taskId = z.number({ error: 'Task ID must be a positive integer' })
  .refine((id) => Number.isSafeInteger(id) && id >= 1, { error: 'Task ID must be a positive integer' })

// --- `kimaki send` (also remote envelopes in ingress.ts).

const sendFields = {
  channelId: text('channelId').optional(),
  threadId: text('threadId').optional(),
  sessionId: text('sessionId').optional(),
  project: text('project').optional(),
  name: text('name').optional(),
  agent: text('agent').optional(),
  model: text('model').optional(),
  user: text('user').optional(),
  cwd: text('cwd').optional(),
  parentSessionId: text('parentSessionId').optional(),
  baseBranch: text('baseBranch').optional(),
  // '' asks for an automatic name.
  worktree: z.string({ error: 'worktree must be a name or an empty string for an automatic name' }).optional(),
  notifyOnly: z.boolean({ error: 'notifyOnly must be boolean' }).optional(),
  permissions: z.array(z.string(), { error: 'Permission rules must be strings' }).optional(),
  prompt: text('prompt'),
  files: z.array(z.object({ uri: z.string(), name: z.string() }), { error: 'files must contain uri and name strings' }).optional(),
}

type SendFields = z.output<z.ZodObject<typeof sendFields>>

function checkSend(input: SendFields, ctx: z.RefinementCtx) {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (input.worktree) {
    const valid = worktreeName(input.worktree)
    if (valid instanceof Error) return fail(valid.message)
  }
  const newSessionOnly = input.cwd !== undefined || input.threadId !== undefined || input.sessionId !== undefined || input.notifyOnly === true
  if (input.worktree !== undefined && newSessionOnly) {
    return fail('--worktree requires a new session; do not combine it with --cwd, --thread, --session or --notify-only')
  }
  if (input.baseBranch !== undefined && input.worktree === undefined) return fail('--base-branch requires --worktree')
  const targets = [input.channelId, input.threadId, input.sessionId, input.project].filter((value) => value !== undefined)
  if (targets.length !== 1) return fail('Use exactly one of --channel, --thread, --session, --project')
}

export const sendInput = z.object(sendFields, { error: 'Expected a send object' }).superRefine(checkSend)

export type SendInput = z.output<typeof sendInput>

const sendRoute = z.object({
  ...sendFields,
  sendAt: z.string({ error: '--send-at must be a string' }).optional(),
  preRun: z.string({ error: '--pre-run must be a command' }).trim().min(1, { error: '--pre-run must be a command' }).optional(),
  allowConcurrency: z.boolean({ error: '--allow-concurrency must be boolean' }).optional(),
}, { error: 'Expected a send object' }).superRefine((input, ctx) => {
  checkSend(input, ctx)
  if (input.sendAt === undefined && (input.preRun !== undefined || input.allowConcurrency !== undefined)) {
    ctx.addIssue({ code: 'custom', message: '--pre-run and --allow-concurrency need --send-at' })
  }
})

// --- `kimaki channel|worktree …`: a project channel, from --channel or the directory.

const channelTarget = {
  channelId: text('channelId').optional(),
  directory: text('directory').optional(),
}

async function projectChannel(bot: Bot, input: { channelId?: string; directory?: string }) {
  const channelId = input.channelId ?? await channelForDirectory(bot, path.resolve(input.directory ?? process.cwd()))
  if (channelId instanceof Error) return channelId
  const project = await projectOf(bot, channelId)
  if (project instanceof Error) return project
  if (!project) return new ConfigError({ reason: 'No local project channel. Pass --channel.' })
  return project.channel_id
}

async function clearChannel(bot: Bot, { channelId, table }: { channelId: string; table: 'agent' | 'model' }) {
  const target = table === 'agent' ? schema.channel_agents : schema.channel_models
  const result = await bot.db.delete(target).where(orm.eq(target.channel_id, channelId))
    .catch((cause) => new DbError({ operation: `clear ${table}`, cause }))
  if (result instanceof Error) return result
  return { cleared: true }
}

const invalidChannelValue = 'Invalid channel action or value'

const worktreeOperation = z.object({
  ...channelTarget,
  text: text('text'),
  targetBranch: text('targetBranch').optional(),
  strategy: oneOf(['rebase', 'squash'], 'Use --strategy rebase or squash.').default('rebase'),
}, { error: 'Expected action arguments' })

function worktreeRoute(operation: 'remove' | 'merge') {
  return route({
    input: worktreeOperation,
    run: async (bot, input) => {
      const channelId = await projectChannel(bot, input)
      if (channelId instanceof Error) return channelId
      return manageWorktree(bot, { channelId, directory: input.text, operation, strategy: input.strategy, targetBranch: input.targetBranch })
    },
  })
}

// --- `kimaki session|queue …`: a local session, from a session or thread ID (src/cli/shared.ts parseTarget).

const sessionTarget = {
  sessionId: text('sessionId').optional(),
  threadId: text('threadId').optional(),
}

function localSession(bot: Bot, input: { sessionId?: string; threadId?: string }) {
  const { sessionThreads, roots } = bot.store.getState()
  const threadId = input.threadId ?? (input.sessionId ? sessionThreads[input.sessionId] : undefined)
  const sessionId = threadId ? roots[threadId] : undefined
  if (!threadId || !sessionId) return new ConfigError({ reason: 'No local session. Pass a session ID, thread ID or thread URL.' })
  if (!bot.opencode.endpoint) return new OpenCodeUnavailableError({ reason: 'not connected' })
  return { threadId, sessionId }
}

// A session ID as is (it can be a subagent), else the root session of the thread.
function sessionOf(bot: Bot, input: { sessionId?: string; threadId?: string }) {
  if (input.sessionId) return input.sessionId
  const root = input.threadId ? bot.store.getState().roots[input.threadId] : undefined
  if (!root) return new ConfigError({ reason: 'No local session. Use --session or run inside an OpenCode session.' })
  return root
}

const sessionInput = <T extends z.ZodRawShape>(shape: T) => z.object({ ...sessionTarget, ...shape }, { error: 'Expected action arguments' })

const sessionText = sessionInput({ text: text('text') })

const cliAuthor = (bot: Bot) => ({ id: bot.discord.user!.id, username: 'CLI' })

// --- Agent UI (`kimaki buttons`, `kimaki upload-request`).

const agentUiFields = {
  ...sessionTarget,
  fromShell: z.boolean().optional(),
  toolCall: z.string().optional(),
}

const buttonSpec = z.string().transform((value, ctx) => {
  const parsed = parseButton(value)
  if (parsed instanceof Error) {
    ctx.addIssue({ code: 'custom', message: parsed.message })
    return z.NEVER
  }
  return parsed
})

// --- Process control: `kimaki restart`, `kimaki profile cpu|heap`.

// Snapshots can hold the bot token: owner-only files.
async function profileFile({ dataDir, name }: { dataDir: string; name: string }): Promise<FilesystemError | string> {
  const directory = path.join(dataDir, 'profiles')
  const created = await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
    .catch((cause) => new FilesystemError({ operation: `mkdir ${directory}`, cause }))
  if (created instanceof Error) return created
  return path.join(directory, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
}

// One CPU profile at a time: the inspector has one profiler per process.
const cpuProfile: { running: boolean } = { running: false }

// Profiles for `durationMs`, or until the CLI disconnects, then writes a .cpuprofile.
async function profileCpu({ dataDir, durationMs, signal }: { dataDir: string; durationMs: number; signal: AbortSignal }) {
  if (cpuProfile.running) return new ConfigError({ reason: 'A CPU profile is already running. Wait for it to finish.' })
  cpuProfile.running = true
  const session = new inspector.Session()
  session.connect()
  const result = await (async () => {
    await session.post('Profiler.enable')
    await session.post('Profiler.start')
    await sleep(durationMs, undefined, { signal }).catch(() => undefined)
    const { profile } = await session.post('Profiler.stop')
    const file = await profileFile({ dataDir, name: 'cpu' })
    if (file instanceof Error) return file
    const target = `${file}.cpuprofile`
    return fs.promises.writeFile(target, JSON.stringify(profile), { mode: 0o600 })
      .then(() => ({ path: target }), (cause: Error) => new FilesystemError({ operation: `write ${target}`, cause }))
  })().catch((cause: Error) => new FilesystemError({ operation: 'cpu profile', cause }))
  session.disconnect()
  cpuProfile.running = false
  return result
}

async function snapshotHeap({ dataDir }: { dataDir: string }) {
  const file = await profileFile({ dataDir, name: 'heap' })
  if (file instanceof Error) return file
  // Blocks the event loop for seconds on a large heap; that is the cost of a snapshot.
  const written = errore.try(() => v8.writeHeapSnapshot(`${file}.heapsnapshot`), (cause) => new FilesystemError({ operation: 'write heap snapshot', cause }))
  if (written instanceof Error) return written
  const chmod = await fs.promises.chmod(written, 0o600).catch((cause) => new FilesystemError({ operation: `chmod ${written}`, cause }))
  if (chmod instanceof Error) return chmod
  return { path: written }
}

const loginField = z.string({ error: 'Login fields must be non-empty strings' }).min(1, { error: 'Login fields must be non-empty strings' }).optional()

export const lockRoutes = {
  send: route({
    input: sendRoute,
    run: async (bot, { sendAt, preRun, allowConcurrency, ...input }) => {
      if (sendAt === undefined) return send(bot, input)
      return createTask(bot, { send: input, options: { sendAt, preRun: preRun ?? null, allowConcurrency: allowConcurrency === true } })
    },
  }),
  upload: route({
    input: z.object({
      id: z.string({ error: 'Upload needs a session and files' }).min(1, { error: 'Upload needs a session and files' }),
      files: z.array(z.object({ path: z.string(), name: z.string() }, { error: 'Invalid upload file' }), { error: 'Upload needs a session and files' }),
    }, { error: 'Upload needs a session and files' }),
    run: async (bot, input) => upload(bot, input),
  }),
  status: route({
    input: z.object({}),
    run: async (bot) => {
      const endpoint = bot.opencode.endpoint
      return {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        dataDir: bot.dataDir,
        mode: bot.token.includes(':') ? 'gateway' as const : 'self_hosted' as const,
        analytics: bot.analytics.enabled,
        opencode: { connected: bot.opencode.connected, url: endpoint?.url ?? null, version: endpoint?.version ?? null },
        guilds: [...bot.discord.guilds.cache.values()].map((guild) => ({ id: guild.id, name: guild.name })),
      }
    },
  }),
  restart: route({
    input: z.object({}),
    run: async () => {
      if (process.env['KIMAKI_SUPERVISED'] !== '1') {
        return new ConfigError({ reason: 'This bot was not started by the `kimaki` command, so nothing would start it again. Stop it and start it yourself.' })
      }
      // After the response: the SIGTERM handler stops the bot and exits with this code.
      process.exitCode = RESTART_EXIT_CODE
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100)
      return { restarting: true, pid: process.pid }
    },
  }),
  'profile.cpu': route({
    input: z.object({ durationMs: z.number({ error: 'durationMs must be a number' }).int().min(100).max(600_000, { error: 'A CPU profile can run at most 10 minutes' }) }),
    run: async (bot, input, signal) => profileCpu({ dataDir: bot.dataDir, durationMs: input.durationMs, signal }),
  }),
  'profile.heap': route({
    input: z.object({}),
    run: async (bot) => snapshotHeap({ dataDir: bot.dataDir }),
  }),
  sleep: route({
    input: z.object({
      ...sessionTarget,
      duration: z.string({ error: 'Sleep fields must be strings' }).optional(),
      until: z.string({ error: 'Sleep fields must be strings' }).optional(),
      reason: z.string({ error: 'Sleep fields must be strings' }).optional(),
    }, { error: 'Expected a sleep object' }),
    run: async (bot, { threadId, ...input }) => {
      const sessionId = sessionOf(bot, { ...input, threadId })
      if (sessionId instanceof Error) return sessionId
      return createSleep(bot, { ...input, sessionId })
    },
  }),
  'task.edit': route({
    input: z.object({
      id: taskId,
      prompt: z.string({ error: 'prompt must be a string' }).trim().optional(),
      sendAt: z.string({ error: 'sendAt must be a string' }).trim().optional(),
      agent: z.string({ error: 'agent must be a string' }).trim().optional(),
      model: z.string({ error: 'model must be a string' }).trim().optional(),
      preRun: z.string({ error: 'preRun must be a string' }).trim().optional(),
      user: z.string({ error: 'user must be a string' }).trim().optional(),
      allowConcurrency: z.boolean({ error: 'allowConcurrency must be boolean' }).optional(),
    }, { error: 'Expected a task edit object' }).superRefine((edit, ctx) => {
      if (Object.entries(edit).every(([key, value]) => key === 'id' || value === undefined)) {
        ctx.addIssue({ code: 'custom', message: 'Pass at least one of --prompt, --send-at, --agent, --model, --pre-run, --allow-concurrency, --user' })
        return
      }
      if (edit.prompt === '') ctx.addIssue({ code: 'custom', message: '--prompt cannot be empty' })
    }),
    run: async (bot, input) => editTask(bot, input),
  }),
  'task.delete': route({
    input: z.object({ id: taskId }, { error: 'Task ID must be a positive integer' }),
    run: async (bot, { id }) => deleteTask(bot, id),
  }),
  'task.run': route({
    input: z.object({ id: taskId }, { error: 'Task ID must be a positive integer' }),
    run: async (bot, { id }) => runTaskNow(bot, id),
  }),
  buttons: route({
    input: z.object({
      ...agentUiFields,
      buttons: z.array(buttonSpec, { error: 'Use 1 to 3 --button flags' })
        .min(1, { error: 'Use 1 to 3 --button flags' })
        .max(3, { error: 'Use 1 to 3 --button flags' })
        .refine((buttons) => buttons.map((item) => item.command ?? '').join('\n').length <= 1800, { error: 'Button commands must fit in one Discord message' }),
    }, { error: 'Expected agent UI input' }),
    run: async (bot, { buttons, threadId, ...input }, signal) => {
      const sessionId = sessionOf(bot, { ...input, threadId })
      if (sessionId instanceof Error) return sessionId
      return bot.features.agentUi.request({ ...input, sessionId, content: { buttons }, signal })
    },
  }),
  'upload-request': route({
    input: z.object({
      ...agentUiFields,
      prompt: z.string({ error: 'Use --prompt and --max-files 1 to 10' }).min(1, { error: 'Use --prompt and --max-files 1 to 10' }).max(2000, { error: 'Use --prompt and --max-files 1 to 10' }),
      maxFiles: z.number({ error: 'Use --prompt and --max-files 1 to 10' }).int({ error: 'Use --prompt and --max-files 1 to 10' })
        .min(1, { error: 'Use --prompt and --max-files 1 to 10' }).max(10, { error: 'Use --prompt and --max-files 1 to 10' }).default(5),
    }, { error: 'Expected agent UI input' }),
    run: async (bot, { prompt, maxFiles, threadId, ...input }, signal) => {
      const sessionId = sessionOf(bot, { ...input, threadId })
      if (sessionId instanceof Error) return sessionId
      return bot.features.agentUi.request({ ...input, sessionId, content: { prompt, maxFiles }, signal })
    },
  }),
  login: route({
    input: z.object({
      provider: z.string({ error: 'Provider is required' }).min(1, { error: 'Provider is required' }),
      key: loginField,
      method: loginField,
      attempt: loginField,
      code: loginField,
      operation: loginField,
    }, { error: 'Expected login object' }),
    run: async (bot, input) => loginCli(bot, input),
  }),
  credential: route({
    input: z.object({
      id: z.string({ error: 'Invalid credential action' }).min(1, { error: 'Invalid credential action' }),
      operation: oneOf(['activate', 'remove', 'label'], 'Invalid credential action'),
      label: z.string({ error: 'Invalid credential action' }).optional(),
    }, { error: 'Expected login object' }),
    run: async (bot, input) => credential(bot, input),
  }),

  'channel.worktrees': route({
    input: z.object({ ...channelTarget, text: oneOf(['on', 'off'], invalidChannelValue) }, { error: 'Expected action arguments' }),
    run: async (bot, input) => {
      const channelId = await projectChannel(bot, input)
      if (channelId instanceof Error) return channelId
      return setAutoWorktrees(bot, { channelId, enabled: input.text === 'on' })
    },
  }),
  'channel.agent': route({
    input: z.object({ ...channelTarget, agent: text('agent').optional(), clear: z.boolean().optional() }, { error: 'Expected action arguments' })
      .refine((input) => input.clear === true || input.agent !== undefined, { error: invalidChannelValue }),
    run: async (bot, input) => {
      const channelId = await projectChannel(bot, input)
      if (channelId instanceof Error) return channelId
      if (input.clear || !input.agent) return clearChannel(bot, { channelId, table: 'agent' })
      const agent = input.agent
      const saved = await setChannelAgent(bot, { channelId, agent })
      if (saved instanceof Error) return saved
      return { agent }
    },
  }),
  'channel.model': route({
    input: z.object({ ...channelTarget, model: text('model').optional(), variant: text('variant').optional(), clear: z.boolean().optional() }, { error: 'Expected action arguments' })
      .refine((input) => input.clear === true || input.model !== undefined, { error: invalidChannelValue }),
    run: async (bot, input) => {
      const channelId = await projectChannel(bot, input)
      if (channelId instanceof Error) return channelId
      if (input.clear || !input.model) return clearChannel(bot, { channelId, table: 'model' })
      const model = parseModel(input.model, input.variant)
      if (!model) return new ConfigError({ reason: 'Use provider/model' })
      const saved = await setChannelModel(bot, { channelId, model: { ...model, variant: input.variant ?? null } })
      if (saved instanceof Error) return saved
      return { model }
    },
  }),
  'channel.verbosity': route({
    input: z.object({ ...channelTarget, text: oneOf(['text', 'tools'], invalidChannelValue) }, { error: 'Expected action arguments' }),
    run: async (bot, input) => {
      const channelId = await projectChannel(bot, input)
      if (channelId instanceof Error) return channelId
      const saved = await setVerbosity(bot, { channelId, verbosity: input.text })
      if (saved instanceof Error) return saved
      return { verbosity: input.text }
    },
  }),
  'worktree.list': route({
    input: z.object(channelTarget, { error: 'Expected action arguments' }),
    run: async (bot, input) => {
      const channelId = await projectChannel(bot, input)
      if (channelId instanceof Error) return channelId
      return channelWorktrees(bot, { channelId })
    },
  }),
  'worktree.create': route({
    input: z.object({ ...channelTarget, name: text('name').optional(), baseBranch: text('baseBranch').optional() }, { error: 'Expected action arguments' }),
    run: async (bot, input) => {
      const channelId = await projectChannel(bot, input)
      if (channelId instanceof Error) return channelId
      return newWorktree(bot, { channelId, name: input.name, baseBranch: input.baseBranch, author: cliAuthor(bot) })
    },
  }),
  'worktree.remove': worktreeRoute('remove'),
  'worktree.merge': worktreeRoute('merge'),

  'session.resume': route({
    input: z.object({ sessionId: text('sessionId'), channelId: text('channelId').optional() }, { error: 'Expected action arguments' }),
    run: async (bot, input) => {
      const channelId = input.channelId ?? await channelForSession(bot, input.sessionId)
      if (channelId instanceof Error) return channelId
      return resume(bot, { channelId, sessionId: input.sessionId, author: cliAuthor(bot) })
    },
  }),
  'session.cwd': route({
    input: sessionInput({ directory: text('directory').optional() }),
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      const thread = await fetchThread(bot, target.threadId)
      if (thread instanceof Error) return thread
      return sessionCwd(bot, { thread, directory: input.directory })
    },
  }),
  'session.title': route({
    input: sessionText,
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      const title = input.text
      const renamed = await oc(bot, 'session.update', (client) => client.session.update({ sessionID: target.sessionId, title }))
      if (renamed instanceof Error) return renamed
      const thread = await fetchThread(bot, target.threadId)
      if (thread instanceof Error) return thread
      const updated = await thread.setName(title.slice(0, 100)).catch((cause) => new DiscordError({ operation: 'rename thread', cause }))
      if (updated instanceof Error) return updated
      return { title }
    },
  }),
  'session.archive': route({
    input: sessionInput({}),
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      const thread = await fetchThread(bot, target.threadId)
      if (thread instanceof Error) return thread
      const archived = await thread.setArchived(true).catch((cause) => new DiscordError({ operation: 'archive thread', cause }))
      if (archived instanceof Error) return archived
      return { archived: true }
    },
  }),
  'session.abort': route({
    input: sessionInput({}),
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      return abort(bot, { threadId: target.threadId })
    },
  }),
  'session.fork': route({
    input: sessionInput({ before: text('before').optional(), name: text('name').optional() }),
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      const thread = await fetchThread(bot, target.threadId)
      if (thread instanceof Error) return thread
      // A child session ID forks that child, not the root.
      return fork(bot, { sourceThread: thread, sessionId: input.sessionId ?? target.sessionId, before: input.before, name: input.name, author: cliAuthor(bot) })
    },
  }),
  'session.command': route({
    input: sessionInput({ text: text('text'), queue: z.boolean().optional() }),
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      return send(bot, { threadId: target.threadId, prompt: `/${input.text}${input.queue ? ' . queue' : ''}` })
    },
  }),
  'session.shell': route({
    input: sessionText,
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      const started = shell(bot, { ...target, command: input.text })
      if (started instanceof Error) return started
      return { started: true }
    },
  }),
  'session.btw': route({
    input: sessionText,
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      return send(bot, { threadId: target.threadId, prompt: `${input.text}. btw` })
    },
  }),
  'queue.add': route({
    input: sessionText,
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      return send(bot, { threadId: target.threadId, prompt: `${input.text}. queue` })
    },
  }),
  'queue.list': route({
    input: sessionInput({}),
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      const inbox = await oc(bot, 'session.inbox.list', (client) => client.session.inbox.list({ sessionID: target.sessionId }))
      if (inbox instanceof Error) return inbox
      return inbox.filter((item) => item.delivery === 'queue')
    },
  }),
  'queue.remove': route({
    input: sessionInput({ inboxId: text('inboxId') }),
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      const removed = await cancelQueuedPrompt(bot, { threadId: target.threadId, inboxID: input.inboxId })
      if (removed instanceof Error) return removed
      return { removed: true }
    },
  }),
  'queue.clear': route({
    input: sessionInput({}),
    run: async (bot, input) => {
      const target = localSession(bot, input)
      if (target instanceof Error) return target
      return clearQueue(bot, { threadId: target.threadId })
    },
  }),
}

export type LockRoutes = typeof lockRoutes
export type LockRouteName = keyof LockRoutes
export type LockRouteInput<N extends LockRouteName> = z.input<LockRoutes[N]['input']>
// What the bot answers; it crossed JSON, so Dates and undefined values do not survive.
export type LockRouteOutput<N extends LockRouteName> = Exclude<Awaited<ReturnType<LockRoutes[N]['run']>>, Error>

function isLockRouteName(name: string): name is LockRouteName {
  return Object.hasOwn(lockRoutes, name)
}

// The lock server's one handler: `route` is the path after /kimaki/.
export async function runLockRoute(bot: Bot, { route: name, input, signal }: { route: string; input: unknown; signal: AbortSignal }) {
  if (!isLockRouteName(name)) return new ConfigError({ reason: `Unknown bot action: ${name}` })
  return lockRoutes[name].handle(bot, input, signal)
}
