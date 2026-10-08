// `send`, `task ...` and `sleep`: start, schedule and wake sessions through
// the running bot. scheduler.ts is bot code: only `task list` loads it, lazily.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { wrapJsonSchema, type Goke } from 'goke'

import { BotNotRunningError } from '../errors.ts'
import { callBot } from '../lock-server.ts'
import { action, DATA_DIR_HELP, dataDirOrDefault, discordApi, fail, openCliDb, parseTarget, printJson, readClient, SESSION_HELP, targetOrEnv, waitAndPrintSession } from './shared.ts'

export function registerSendCommand(cli: Goke) {
  cli.command('send', 'Start a session in a channel, or continue a thread')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'New thread in this channel')
    .option('-d, --project <path>', 'Project directory of the new thread')
    .option('--thread <id>', 'Continue this thread (ID or URL)')
    .option('-s, --session <id>', 'Continue this session: session ID, thread ID or thread URL')
    .option('-p, --prompt <text>', 'Prompt; thread suffixes . queue and . btw are supported')
    .option('-f, --file <path>', wrapJsonSchema<string[]>({ type: 'array', items: { type: 'string' }, description: 'Attach a local file (repeatable)' }))
    .option('-n, --name <text>', 'Thread name')
    .option('--agent <name>', 'Agent ID')
    .option('--model <provider/model>', 'Model for the new session')
    .option('-u, --user <id>', 'Add this Discord user to the thread')
    .option('--cwd <path>', 'Existing project subfolder or linked Git worktree')
    .option('--worktree [name]', 'Create a custom Git worktree (automatic name when omitted)')
    .option('--base-branch <ref>', 'Starting ref for --worktree (default: project HEAD)')
    .option('--parent-session <id>', 'Record the parent session in session metadata')
    .option('--permission <rule>', wrapJsonSchema<string[]>({ type: 'array', items: { type: 'string' }, description: 'Repeatable: tool[:pattern]:allow|deny|ask' }))
    .option('--notify-only', 'Post a notification thread without a model turn')
    .option('--wait', 'Wait until idle or input is needed, then print the session')
    .option('--send-at <when>', 'Schedule: UTC ISO date ending in Z, or cron expression (UTC)')
    .option('--pre-run <command>', 'Scheduled only: run first in the project. Exit 0 starts, stdout is appended')
    .option('--allow-concurrency', 'Scheduled only: allow overlapping runs of this task')
    .action(async (options) => {
      if (options.wait && options.sendAt) fail(new Error('--wait cannot be used with --send-at: the task runs later'))
      if (options.thread !== undefined && options.session !== undefined) fail(new Error('Use exactly one of --channel, --thread, --session, --project'))
      const continued = options.thread ?? options.session
      const target = continued === undefined ? {} : parseTarget(continued)
      if (target instanceof Error) fail(target)
      const input = {
        channelId: options.channel, project: options.project, ...target,
        prompt: options.prompt, name: options.name, agent: options.agent, model: options.model, user: options.user,
        cwd: options.cwd, worktree: options.worktree, baseBranch: options.baseBranch, parentSessionId: options.parentSession,
        permissions: options.permission, notifyOnly: options.notifyOnly,
        files: (options.file ?? []).map((file) => ({ uri: pathToFileURL(path.resolve(file)).href, name: path.basename(file) })),
      }
      const result = await callBot({
        dataDir: dataDirOrDefault(options.dataDir),
        route: 'send',
        signal: AbortSignal.timeout(25 * 60_000),
        input: { ...input, sendAt: options.sendAt, preRun: options.preRun, allowConcurrency: options.allowConcurrency },
      })
      if (result instanceof BotNotRunningError) {
        // No local bot (CI, another machine): the bot that owns the channel runs it (remote-send.ts).
        if (options.sendAt || options.wait) fail(new Error('Kimaki bot is not running here. --send-at and --wait need a local bot.'))
        const [{ sendInput }, { sendWithoutBot }] = await Promise.all([import('../lock-routes.ts'), import('../remote-send.ts')])
        const parsed = sendInput.safeParse(input)
        if (!parsed.success) fail(new Error(parsed.error.issues.map((issue) => issue.message).join('; ')))
        const { api } = await discordApi(options.dataDir)
        const sent = await sendWithoutBot({ api, input: parsed.data })
        if (sent instanceof Error) fail(sent)
        process.stdout.write(`${JSON.stringify(sent)}\n`)
        return
      }
      if (result instanceof Error) fail(result)
      process.stdout.write(`${JSON.stringify(result.data)}\n`)
      if (!options.wait) return
      const data = result.data
      if (!data || typeof data !== 'object' || !('sessionId' in data) || typeof data.sessionId !== 'string') fail(new Error('--wait requires an AI session, not --notify-only'))
      await waitAndPrintSession({ client: await readClient(), sessionId: data.sessionId })
    })
}

// task list / edit / delete / run, sleep
export function registerScheduleCommands(cli: Goke) {
  cli.command('task list', 'List scheduled tasks (planned, running, failed)')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { listTasks } = await import('../scheduler.ts')
      const opened = await openCliDb(options.dataDir)
      const tasks = await listTasks({ db: opened.db })
      opened.close()
      if (tasks instanceof Error) fail(tasks)
      if (options.json) return printJson(tasks)
      if (tasks.length === 0) {
        process.stdout.write('No scheduled tasks\n')
        return
      }
      const header = 'id | status | schedule | nextRunAt | channel | thread | user | agent | model | preRun | allowConcurrency | prompt'
      const rows = tasks.map((task) =>
        [task.id, task.status, task.schedule, task.nextRunAt, task.channelId, task.threadId, task.userId, task.agent, task.model, task.preRun, task.allowConcurrency, task.prompt]
          .map((value) => value ?? '-')
          .join(' | '),
      )
      process.stdout.write(`${[header, ...rows].join('\n')}\n`)
    })

  cli.command('task edit <taskId>', 'Change a planned task. An empty string clears a value')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--prompt <text>', 'New prompt')
    .option('--send-at <when>', 'New schedule: UTC ISO date ending in Z, or cron (UTC)')
    .option('--agent <name>', 'Agent for the scheduled session')
    .option('--model <provider/model>', 'Model for the scheduled session')
    .option('-u, --user <id>', 'Discord user ID added to each run\'s thread')
    .option('--pre-run <command>', 'Command to run before each run')
    .option('--allow-concurrency <bool>', 'true | false')
    .action(async (taskId, options) => {
      const flag = options.allowConcurrency
      if (flag && flag !== 'true' && flag !== 'false') fail(new Error('--allow-concurrency must be true or false'))
      await action({ route: 'task.edit', dataDir: options.dataDir, input: {
        id: Number(taskId), prompt: options.prompt, sendAt: options.sendAt, agent: options.agent, model: options.model,
        user: options.user, preRun: options.preRun, allowConcurrency: flag ? flag === 'true' : undefined,
      } })
    })

  for (const [name, description] of [['delete', 'Delete a scheduled task'], ['run', 'Run a scheduled task now']] as const) {
    cli.command(`task ${name} <taskId>`, description)
      .option('--data-dir <path>', DATA_DIR_HELP)
      .action(async (taskId, options) => {
        // A run waits for its pre-run command (up to 10 minutes) and the session start.
        const signal = name === 'run' ? AbortSignal.timeout(12 * 60_000) : undefined
        await action({ route: `task.${name}`, dataDir: options.dataDir, input: { id: Number(taskId) }, signal })
      })
  }

  cli.command('sleep', 'Wake this session later with a new message in the same thread. Run it last, after your text. To monitor slow events (email replies, PR reviews), wait 2h or more; never poll every few minutes')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--duration <duration>', 'Relative wait, e.g. 30m, 2h, 1d')
    .option('--until <date>', 'UTC ISO date ending in Z')
    .option('--reason <text>', 'Shown in Discord and in the wake message')
    .option('-s, --session <id>', SESSION_HELP)
    .action(async (options) => {
      // The bot parses --duration/--until with its own clock (scheduler.ts parseWakeAt).
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'sleep', input: {
        ...targetOrEnv(options.session), duration: options.duration, until: options.until, reason: options.reason,
      } })
      if (result instanceof Error) fail(result)
      process.stdout.write(`${result.data.output}\n`)
    })
}
