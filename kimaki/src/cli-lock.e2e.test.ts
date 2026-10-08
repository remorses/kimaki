import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { BotHandle } from './main.ts'
import { seedProjectChannel, startOpencodeTestServer, startTestBot, startTwin, tempDataDir, waitFor, waitForFooter, warmUp, type OpencodeTestServer, type TestTwin } from './test/harness.ts'

const exec = promisify(execFile)
const dataDir = tempDataDir()
let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle

beforeAll(async () => {
  ;[server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({ dataDir, twin, server })
  await warmUp({ server })
}, 60_000)
afterAll(async () => {
  await bot?.stop()
  await Promise.all([server?.stop(), twin?.stop()])
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function cli(args: string[]) {
  return exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), ...args, '--data-dir', dataDir], {
    env: { ...process.env, KIMAKI_LOCK_PORT: String(bot.lock.port), KIMAKI_OPENCODE_SERVICE_FILE: server.serviceFile },
  })
}

test('CLI send starts and continues a session through the authenticated bot API', async () => {
  const first = await cli(['send', '--channel', twin.channelId, '--prompt', 'CLI first'])
  const ids = JSON.parse(first.stdout) as { threadId: string; sessionId: string }
  await waitForFooter({ discord: twin.discord, threadId: ids.threadId })
  await cli(['send', '--thread', ids.threadId, '--prompt', 'CLI second. queue'])
  await waitForFooter({ discord: twin.discord, threadId: ids.threadId, count: 2 })
  expect(await twin.discord.thread(ids.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** CLI first
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect(ids.sessionId).toMatch(/^ses_/)
  const tokenFile = path.join(dataDir, 'lock-token')
  expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600)
  const unauthorized = await fetch(`http://127.0.0.1:${bot.lock.port}/kimaki/send`, { method: 'POST', body: '{}' })
  expect(unauthorized.status).toBe(401)
  const token = fs.readFileSync(tokenFile, 'utf8')
  const invalid = await fetch(`http://127.0.0.1:${bot.lock.port}/kimaki/send`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ channelId: { gt: '0' }, prompt: 'unsafe' }),
  })
  expect(invalid.status).toBe(400)
})

test('CLI help documents the supported P7 commands', async () => {
  const output = await cli(['--help'])
  expect(output.stdout).toContain('send')
  expect(output.stdout).toContain('upload-request')
  expect(output.stdout).toMatchInlineSnapshot(`
    "kimaki

    Usage:
      $ kimaki [options]

    Commands:
      kimaki                            Start the bot. Runs onboarding on first start

      Project:
      project list                      List project directories and their channels
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --json                          Output as JSON

      project add [directory]           Create a channel for a directory (default: current directory)
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -g, --guild <guildId>           Server (default: the one with Kimaki channels)
        --machine-name <name>           Machine name of a new category and of a channel name suffix (default: hostname)

      Session:
      session list                      List sessions with native status and token counts
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --project <path>                Project (default: current directory)
        --all                           All projects
        --active                        Only busy sessions; exit 1 when none remain, 64 on errors
        --exclude <id>                  Exclude session (repeatable)
        --json                          Output as JSON

      session search <query>            Search titles, then real message content
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --project <path>                Project (default: current directory)
        -c, --channel <id>              Project of this Discord channel
        --all                           All projects
        --days <n>                      Recent days (default: 14; 0 = all)
        --json                          Output as JSON

      session wait <id>                 Wait until idle or waiting for input, then print the session
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --timeout <duration>            Timeout, for example 30m or 2h

      session editors <file>            List sessions that last edited a file, newest first
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --json                          Output as JSON
        --limit <n>                     Max sessions to show (default: 20)

      session diff                      Upload the git diff of the session folder to critique.work and print the URL
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)

      session url <id>                  Print the Discord URL of a session or thread
        --data-dir <path>               Data directory (default: ~/.kimaki)

      channel agent [value]             Set channel agent through the running bot
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -c, --channel <id>              Target channel (default: current project)
        --clear                         Clear the saved agent

      channel model [value]             Set channel model through the running bot
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -c, --channel <id>              Target channel (default: current project)
        --variant <name>                Thinking variant for model
        --global                        Default of all channels without their own model
        --clear                         Clear the saved model

      channel verbosity [value]         Set channel verbosity through the running bot
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -c, --channel <id>              Target channel (default: current project)

      session abort [id]                Stop the running turn and clear its queue
        --data-dir <path>               Data directory (default: ~/.kimaki)

      session archive [id]              Archive a session thread
        --data-dir <path>               Data directory (default: ~/.kimaki)

      session title <title>             Rename the session and its Discord thread
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)

      session queue add <value>         add native queued prompts
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)
        --json                          Output as JSON

      session queue remove <value>      remove native queued prompts
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)
        --json                          Output as JSON

      session queue list                list native queued prompts
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)
        --json                          Output as JSON

      session queue clear               clear native queued prompts
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)
        --json                          Output as JSON

      session command <name> [...args]  Run an OpenCode command, skill, or MCP prompt
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)
        --queue                         Run after the current turn instead of interrupting

      session shell <text>              Run shell through the shared session action
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)
        --queue                         Queue an OpenCode command

      session btw <text>                Run btw through the shared session action
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)
        --queue                         Queue an OpenCode command

      session fork [id]                 Fork a root or child session into a new thread
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --before <messageId>            Fork before this user message
        -n, --name <name>               Thread name

      session resume <id>               Bind an existing session to a new thread in its project channel
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -c, --channel <id>              Destination channel (default: channel of the session folder)

      buttons                           Show 1-3 action buttons. Call last, after visible text
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)
        -b, --button <spec>             Repeatable: Label[:white|blue|green|red]

      upload-request                    Ask for file uploads; waits up to 6 minutes. Shell timeout must be 10 minutes
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)
        -p, --prompt <text>             Text above the upload button
        --max-files <n>                 1 to 10 (default: 5)

      login <provider>                  Connect a provider using OpenCode integration credentials
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --key <key>                     API key to store in OpenCode
        --method <id>                   OAuth method ID; without flags, list login methods
        --attempt <id>                  Check or complete this native OAuth attempt
        --code <code>                   Authorization code for the attempt
        --cancel                        Cancel the native OAuth attempt

      login credential <id>             Activate, remove, or label an OpenCode credential
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --operation <name>              activate | remove | label
        --label <text>                  Credential label

      send                              Start a session in a channel, or continue a thread
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -c, --channel <id>              New thread in this channel
        -d, --project <path>            Project directory of the new thread
        --thread <id>                   Continue this thread (ID or URL)
        -s, --session <id>              Continue this session: session ID, thread ID or thread URL
        -p, --prompt <text>             Prompt; thread suffixes . queue and . btw are supported
        -f, --file <path>               Attach a local file (repeatable)
        -n, --name <text>               Thread name
        --agent <name>                  Agent ID
        --model <provider/model>        Model for the new session
        -u, --user <id>                 Add this Discord user to the thread
        --cwd <path>                    Existing project subfolder or linked Git worktree
        --worktree [name]               Create a custom Git worktree (automatic name when omitted)
        --base-branch <ref>             Starting ref for --worktree (default: project HEAD)
        --parent-session <id>           Record the parent session in session metadata
        --permission <rule>             Repeatable: tool[:pattern]:allow|deny|ask
        --notify-only                   Post a notification thread without a model turn
        --wait                          Wait until idle or input is needed, then print the session
        --send-at <when>                Schedule: UTC ISO date ending in Z, or cron expression (UTC)
        --pre-run <command>             Scheduled only: run first in the project. Exit 0 starts, stdout is appended
        --allow-concurrency             Scheduled only: allow overlapping runs of this task

      session events <id>               Print the recorded OpenCode events of a thread as JSONL (root + subagents)
        --data-dir <path>               Data directory (default: ~/.kimaki)

      session read <id>                 Print the messages of a session from OpenCode as markdown
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --thinking                      Include reasoning
        --verbose                       Include full tool inputs and outputs
        --json                          Print raw OpenCode messages

      session cwd [directory]           Show or change the working directory at a native safe boundary
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)

      Channel:
      channel worktrees <value>         Set automatic worktrees: on | off
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -c, --channel <id>              Project channel (default: current directory)

      Worktree:
      worktree list                     List linked Git worktrees
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -c, --channel <id>              Project channel
        -p, --project <path>            Project directory (default: current directory)

      worktree create [name]            Create an isolated worktree session
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -c, --channel <id>              Project channel
        -p, --project <path>            Project directory (default: current directory)
        --base-branch <ref>             Starting Git ref (default: project HEAD)

      worktree remove <directory>       Remove a clean, merged worktree checkout; retain branch refs
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -c, --channel <id>              Project channel
        -p, --project <path>            Project directory (default: current directory)
        --target-branch <branch>        Local merge target branch
        --strategy <name>               Merge strategy: rebase | squash

      worktree merge <directory>        Merge into a local target branch
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -c, --channel <id>              Project channel
        -p, --project <path>            Project directory (default: current directory)
        --target-branch <branch>        Local merge target branch
        --strategy <name>               Merge strategy: rebase | squash

      Schedule:
      task list                         List scheduled tasks (planned, running, failed)
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --json                          Output as JSON

      task edit <taskId>                Change a planned task. An empty string clears a value
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --prompt <text>                 New prompt
        --send-at <when>                New schedule: UTC ISO date ending in Z, or cron (UTC)
        --agent <name>                  Agent for the scheduled session
        --model <provider/model>        Model for the scheduled session
        -u, --user <id>                 Discord user ID added to each run's thread
        --pre-run <command>             Command to run before each run
        --allow-concurrency <bool>      true | false

      task delete <taskId>              Delete a scheduled task
        --data-dir <path>               Data directory (default: ~/.kimaki)

      task run <taskId>                 Run a scheduled task now
        --data-dir <path>               Data directory (default: ~/.kimaki)

      sleep                             Wake this session later with a new message in the same thread. Run it last, after your text. To monitor slow events (email replies, PR reviews), wait 2h or more; never poll every few minutes
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --duration <duration>           Relative wait, e.g. 30m, 2h, 1d
        --until <date>                  UTC ISO date ending in Z
        --reason <text>                 Shown in Discord and in the wake message
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)

      Discord:
      thread list                       List active and optionally archived threads in a channel
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -c, --channel <id>              Channel to list
        --archived                      Include archived threads
        --json                          Output as JSON

      user list                         Find Discord users for mentions
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -g, --guild <id>                Guild to search
        -q, --query <text>              Name filter
        --json                          Output as JSON

      upload-to-discord <...files>      Attach local files to a session thread
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -s, --session <id>              Session ID, Discord thread ID or thread URL (default: OPENCODE_SESSION_ID)

      Tools:
      tunnel                            Run a command and expose its local port with a public URL. The child gets TRAFORO_URL
        -p, --port <port>               Local port (default: read from the command output)
        -t, --tunnel-id <id>            Fixed tunnel ID (default: random). Only for public-safe services
        --host <host>                   Local host (default: localhost)
        -k, --kill                      Kill the process on --port first

      tts [text]                        Text to speech with OpenAI or Gemini. Reads stdin if no text is given
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -o, --output <path>             Output file (default: speech.mp3 or speech.wav)
        -p, --provider <name>           openai | gemini (default: from the stored key)
        -v, --voice <voice>             Voice ID (default: alloy for OpenAI, Kore for Gemini)
        -i, --instructions <text>       Style instructions (OpenAI only)
        --speed <n>                     0.25 to 4.0 (OpenAI only, default: 1.25)

      Bot:
      status                            Bot health: running, pid, uptime, OpenCode URL and version, guilds
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --json                          Output as JSON

      logs                              Print the log file path. The bot resets the file on every start
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -f, --follow                    Print the log and keep printing new lines

      restart                           Restart the running bot with the code on disk. Sessions keep running in OpenCode
        --data-dir <path>               Data directory (default: ~/.kimaki)

      profile cpu                       Record a CPU profile of the running bot and print the .cpuprofile path
        --data-dir <path>               Data directory (default: ~/.kimaki)
        -d, --duration <duration>       How long to record, e.g. 20s or 2m (default: 20s)

      profile heap                      Write a heap snapshot of the running bot and print the .heapsnapshot path
        --data-dir <path>               Data directory (default: ~/.kimaki)

      bot token                         Print saved bot credentials for automation
        --data-dir <path>               Data directory (default: ~/.kimaki)

      bot keys set                      Store OpenAI or Gemini API keys for voice transcription and kimaki tts
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --openai <key>                  OpenAI API key
        --gemini <key>                  Gemini API key

      bot install-url                   Print the Discord bot install URL
        --data-dir <path>               Data directory (default: ~/.kimaki)
        --gateway-callback-url <url>    Gateway only: redirect here after the install

    Options:
      --data-dir <path>             Data directory (default: ~/.kimaki)
      -g, --guild <guildId>         Server to onboard when the bot is in several
      --gateway                     Use the shared Kimaki bot, no Discord app needed
      --gateway-callback-url <url>  Redirect here after the gateway install (appends ?guild_id=<id>)
      --install-url                 Print the install URL and exit (non-interactive onboarding)
      --machine-name <name>         Name in this machine's category "Kimaki <name>" (default: hostname)
      --restart-onboarding          Choose credentials again
      --worktrees                   Use a fresh Git worktree for new sessions unless the channel overrides it
      --no-analytics                Disable anonymous usage analytics (same as KIMAKI_STRADA_ENABLED=0)
      -h, --help                    Display this message
    "
  `)
})

test('CLI registry shares thread actions, preferences, title and archive', async () => {
  const started = JSON.parse((await cli(['send', '--channel', twin.channelId, '-p', 'Registry first'])).stdout) as { threadId: string; sessionId: string }
  await waitForFooter({ discord: twin.discord, threadId: started.threadId })
  await cli(['channel', 'agent', 'plan', '--channel', twin.channelId])
  await cli(['channel', 'model', 'deterministic-provider/deterministic-v2', '--channel', twin.channelId])
  await cli(['channel', 'verbosity', 'text', '--channel', twin.channelId])
  await cli(['channel', 'model', 'deterministic-provider/deterministic-v2', '--global', '--variant', 'fast'])
  const global = await bot.db.query.global_models.findFirst()
  expect({ app: global?.app_id === bot.appId, model: global?.model_id, variant: global?.variant }).toMatchInlineSnapshot(`
    {
      "app": true,
      "model": "deterministic-provider/deterministic-v2",
      "variant": "fast",
    }
  `)
  await cli(['channel', 'model', '--global', '--clear'])
  expect(await bot.db.query.global_models.findFirst()).toBeUndefined()
  // --session takes a session ID, a thread ID or a thread URL.
  await cli(['session', 'title', 'CLI renamed', '--session', `https://discord.com/channels/${twin.discord.guildId}/${started.threadId}`])
  await cli(['session', 'queue', 'add', 'Registry queued', '--session', started.threadId])
  await expect(cli(['session', 'queue', 'list', '--session', 'not-an-id'])).rejects.toThrow('Not a session ID, Discord thread ID or thread URL: not-an-id')
  await waitForFooter({ discord: twin.discord, threadId: started.threadId, count: 2 })
  await cli(['session', 'abort', started.sessionId])
  await cli(['session', 'archive', started.threadId])
  expect(await twin.discord.thread(started.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** Registry first
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect((await twin.discord.channel(twin.channelId).getThreads()).find((thread) => thread.id === started.threadId)?.name).toBe('CLI renamed')
})

test('send settings reach native session creation; notifications create no session', async () => {
  const subdir = path.join(server.projectDirectory, 'subfolder')
  fs.mkdirSync(subdir)
  const result = await cli(['send', '--channel', twin.channelId, '-p', 'Send settings', '--cwd', subdir, '--permission', 'shell:deny', '--parent-session', 'ses_parent', '--agent', 'build', '--wait'])
  const ids = JSON.parse(result.stdout.split('\n')[0]!) as { threadId: string; sessionId: string }
  await waitForFooter({ discord: twin.discord, threadId: ids.threadId })
  expect(await twin.discord.thread(ids.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** Send settings
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *subfolder ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  const info = await (await server.client()).session.get({ sessionID: ids.sessionId })
  expect(info.location.directory).toBe(subdir)
  expect(info.permissions).toEqual([
    { action: 'question', resource: '*', effect: 'deny' },
    { action: 'shell', resource: '*', effect: 'deny' },
  ])
  await expect(cli(['send', '--thread', ids.threadId, '-p', 'Must not run', '--permission', 'shell:deny']))
    .rejects.toMatchObject({ stderr: expect.stringContaining('--permission applies only to new sessions') })
  expect(info.metadata?.['kimaki']).toMatchObject({ parentSessionId: 'ses_parent' })
  expect(result.stdout).toContain('# Send settings')
  const notice = JSON.parse((await cli(['send', '--channel', twin.channelId, '-p', 'Notification only', '--notify-only'])).stdout) as { threadId: string; sessionId: null }
  expect(await twin.discord.thread(notice.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Notification only"
  `)
  expect(notice.sessionId).toBe(null)
  expect(bot.store.getState().roots[notice.threadId]).toBeUndefined()
})

test('status reports the running bot, logs prints and follows the log file', async () => {
  const running = JSON.parse((await cli(['status', '--json'])).stdout) as Record<string, unknown>
  const opencode = running['opencode'] as { url: string; version: string; connected: boolean }
  expect({ ...running, mode: running['mode'] === (twin.discord.botToken.includes(':') ? 'gateway' : 'self_hosted'), guilds: (running['guilds'] as Array<{ id: string; name: string }>).map((guild) => ({ ...guild, id: guild.id === twin.discord.guildId })), pid: typeof running['pid'], uptimeSec: typeof running['uptimeSec'], dataDir: running['dataDir'] === dataDir, opencode: { ...opencode, url: opencode.url === bot.opencode.endpoint?.url, version: typeof opencode.version } }).toMatchInlineSnapshot(`
    {
      "analytics": false,
      "dataDir": true,
      "guilds": [
        {
          "id": true,
          "name": "Kimaki Test",
        },
      ],
      "mode": true,
      "opencode": {
        "connected": true,
        "url": true,
        "version": "string",
      },
      "pid": "number",
      "running": true,
      "uptimeSec": "number",
    }
  `)

  // A data dir without a running bot.
  const otherDir = tempDataDir()
  const stopped = await exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'status', '--json', '--data-dir', otherDir]).catch((error: { code: number; stdout: string }) => error)
  fs.rmSync(otherDir, { recursive: true, force: true })
  expect({ code: 'code' in stopped ? stopped.code : 0, stdout: JSON.parse(stopped.stdout) }).toMatchInlineSnapshot(`
    {
      "code": 1,
      "stdout": {
        "reason": "Kimaki bot is not running. Start kimaki first.",
        "running": false,
      },
    }
  `)

  expect((await cli(['logs'])).stdout.trim()).toBe(path.join(dataDir, 'kimaki.log'))
  const follow = execFile(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'logs', '--follow', '--data-dir', dataDir])
  const output = { text: '' }
  follow.stdout?.on('data', (chunk: Buffer) => (output.text += chunk.toString()))
  fs.appendFileSync(path.join(dataDir, 'kimaki.log'), 'follow-marker-line\n')
  await waitFor({ label: 'followed log line', check: async () => output.text.includes('follow-marker-line') })
  follow.kill()
})

test('profile cpu and profile heap write owner-only files; restart needs the supervisor', async () => {
  const cpu = (await cli(['profile', 'cpu', '--duration', '200ms'])).stdout.trim()
  const heap = (await cli(['profile', 'heap'])).stdout.trim()
  const profile = JSON.parse(fs.readFileSync(cpu, 'utf8')) as { nodes: unknown[] }
  expect({
    cpu: path.relative(dataDir, cpu).replace(/cpu-.*/, 'cpu-<time>.cpuprofile'),
    heap: path.relative(dataDir, heap).replace(/heap-.*/, 'heap-<time>.heapsnapshot'),
    cpuMode: (fs.statSync(cpu).mode & 0o777).toString(8),
    heapMode: (fs.statSync(heap).mode & 0o777).toString(8),
    hasNodes: profile.nodes.length > 0,
  }).toMatchInlineSnapshot(`
    {
      "cpu": "profiles/cpu-<time>.cpuprofile",
      "cpuMode": "600",
      "hasNodes": true,
      "heap": "profiles/heap-<time>.heapsnapshot",
      "heapMode": "600",
    }
  `)
  // The test bot runs in-process, not under the `kimaki` supervisor.
  const restart = await cli(['restart']).catch((error: { code: number; stderr: string }) => error)
  expect('code' in restart ? { code: restart.code, stderr: restart.stderr.trim() } : restart).toMatchInlineSnapshot(`
    {
      "code": 1,
      "stderr": "This bot was not started by the \`kimaki\` command, so nothing would start it again. Stop it and start it yourself.",
    }
  `)
}, 60_000)
