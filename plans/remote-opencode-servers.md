---
title: Remote OpenCode Servers
description: |
  Architecture plan for supporting remote OpenCode servers in Kimaki.
  Allows projects on different machines (dev servers, VPS, Vercel sandbox,
  CI runners) to be controlled from the same Discord server.
  Updated: thread-per-machine model (not channel-per-machine), hrana
  server already built, OpenCode server auth with OPENCODE_SERVER_PASSWORD.
prompt: |
  Based on deep analysis of all communication paths between database,
  OpenCode servers, OpenCode plugin, and kimaki process. Key files read:
  opencode.ts, opencode-plugin.ts, db.ts, database.ts, session-handler.ts,
  discord-bot.ts, system-message.ts, commands/permissions.ts,
  commands/ask-question.ts, commands/file-upload.ts, discord-utils.ts,
  interaction-handler.ts, tools.ts, schema.prisma, cli.ts,
  hrana-server.ts (already implemented).
  Oracle agent consulted for plan review.
  OpenCode server auth docs: https://opencode.ai/docs/server/
---

# Remote OpenCode Servers

## Problem

Today, Kimaki runs entirely on one machine. The Discord bot, SQLite
database, and all OpenCode server processes share a single host. Every
Discord channel maps to a local directory path.

Users want to:

- Run OpenCode on a remote VPS or cloud VM where the code lives
- Use ephemeral sandbox machines (Vercel sandbox, GitHub Codespace, etc.)
- Have multiple machines contribute projects to the same Discord server
- Keep the Discord bot on a lightweight always-on machine while heavy
  AI work runs elsewhere

## Current Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Kimaki Host (single machine)        │
│                                                      │
│  ┌──────────────┐     ┌──────────────────────────┐  │
│  │ Discord Bot   │────>│ SQLite DB (Prisma)        │  │
│  │ (session-     │     │ discord-sessions.db       │  │
│  │  handler,     │     │                           │  │
│  │  interactions)│     │ - thread_sessions         │  │
│  └──────┬───────┘     │ - channel_directories     │  │
│         │              │ - models, agents, etc.    │  │
│         │              └──────────────────────────┘  │
│         │                        ^                    │
│         v                        │                    │
│  ┌──────────────┐     ┌─────────┴────────────────┐  │
│  │ OpenCode     │     │ OpenCode Plugin           │  │
│  │ Server       │<────│ (runs inside OpenCode)    │  │
│  │ (child proc) │     │                           │  │
│  │ port 12345   │     │ - getPrisma() direct      │  │
│  └──────────────┘     │ - Discord REST direct     │  │
│                        │ - HTTP -> lock server     │  │
│                        └──────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Communication paths today

1. **Bot -> DB**: Prisma client with `file:` URL to local SQLite
2. **Bot -> OpenCode**: SDK HTTP client to `http://127.0.0.1:<port>`
3. **Bot <- OpenCode**: SSE event stream from same localhost URL
4. **Plugin -> DB**: Direct `getPrisma()` call (same process, same file)
5. **Plugin -> Discord**: REST API using bot token from env var
6. **Plugin -> Bot**: HTTP POST to `http://127.0.0.1:<lockPort>/file-upload`
7. **CLI (in OpenCode bash) -> DB**: `getPrisma()` with `file:` URL
8. **CLI -> Discord**: REST API using bot token from env var

## Proposed Architecture

### Thread-per-machine model

Remote machines are **threads, not channels**. A single project
channel (e.g. `#backend`) stays mapped to the local project directory.
Users run `/new-machine` inside that channel to create a thread that
targets a remote machine. This is simpler than one channel per machine:

- No channel sprawl - one channel per project, threads per machine
- Threads inherit the project context from the parent channel
- Multiple remote machines can coexist under the same project
- Follows the existing kimaki pattern (worktree threads, session threads)

```
Discord server:
  #backend (local project)
    ├── Thread: "my-vps" (remote, ssh)
    ├── Thread: "gpu-box" (remote, ssh)
    └── Thread: "sandbox-abc" (remote, vercel)
```

### Hrana server (already built)

The key insight: **we already use `@prisma/adapter-libsql`** which
supports both `file:` and `http://` URLs. We already have an
**in-process hrana v2 server** (`hrana-server.ts`) that serves the
SQLite DB over HTTP on the lock port. By tunneling this via traforo,
remote OpenCode processes can access the same database over the network.

**Status:** Phase 1 from the original plan is done. `hrana-server.ts`
is the single owner of the `.db` file. Local OpenCode child processes
already connect via `KIMAKI_DB_URL=http://127.0.0.1:<lockPort>`.
What remains is adding tunnel exposure + auth for remote connections.

### OpenCode server auth

OpenCode `serve` has built-in HTTP basic auth. Remote OpenCode servers
must be protected so only kimaki can talk to them:

```bash
OPENCODE_SERVER_PASSWORD=<secret> opencode serve --port 7777
```

| Env var | Purpose | Default |
|---|---|---|
| `OPENCODE_SERVER_PASSWORD` | Enables basic auth on OpenCode server | *(none)* |
| `OPENCODE_SERVER_USERNAME` | Sets the username | `opencode` |

Kimaki generates a random password per machine and stores it in the DB.
The SDK client passes basic auth credentials when connecting to remote
OpenCode servers. This means two layers of auth for remote:

1. **OpenCode server auth** - basic auth protects the OpenCode HTTP API
2. **Hrana tunnel auth** - bot token protects DB access via tunnel

```
┌──────────────────────────────────────────────────────────┐
│                  Kimaki Host                              │
│                                                           │
│  ┌──────────────┐                                        │
│  │ Discord Bot   │──┐  http://127.0.0.1:<lockPort>       │
│  │ (session-     │  │  (no auth on localhost)             │
│  │  handler,     │  │                                     │
│  │  interactions)│  │                                     │
│  └──────────────┘  │  ┌──────────────────────────────┐   │
│                     ├─>│ Hrana server (in-process)     │   │
│  ┌──────────────┐  │  │ hrana-server.ts               │   │
│  │ Local OpenCode│──┘  │ single owner of .db file     │   │
│  │ Server        │     │ localhost = no auth           │   │
│  │ (child proc)  │     │ tunnel = bot token auth      │   │
│  └──────────────┘     └────────────┬─────────────────┘   │
│                             ┌───────┴──────────┐          │
│                             │ traforo tunnel   │          │
│                             └───────┬──────────┘          │
└─────────────────────────────────────┼────────────────────┘
                                      │ internet
                   ┌──────────────────┼─────────────────┐
                   │  Remote Machine   │                 │
                   │                   v                 │
                   │  ┌──────────────────────────────┐  │
                   │  │ OpenCode Server               │  │
                   │  │ (standalone, not child)       │  │
                   │  │ protected by basic auth       │  │
                   │  │                               │  │
                   │  │ env:                          │  │
                   │  │  OPENCODE_SERVER_PASSWORD=<x> │  │
                   │  │  KIMAKI_DB_URL=http://        │  │
                   │  │    kimaki-db.traforo.dev      │  │
                   │  │  KIMAKI_DB_TOKEN=<bot_tk>     │  │
                   │  │  KIMAKI_BOT_TOKEN=<bot_tk>    │  │
                   │  └──────────────────────────────┘  │
                   │         │                           │
                   │         v                           │
                   │  ┌──────────────────────────────┐  │
                   │  │ Plugin + CLI                  │  │
                   │  │ getPrisma() ->                │  │
                   │  │   http://tunnel URL           │  │
                   │  │ Discord REST -> direct        │  │
                   │  └──────────────────────────────┘  │
                   └─────────────────────────────────────┘
```

**Key design decisions:**

- **Thread per machine, not channel per machine.** `/new-machine`
  creates a thread in the project channel. Thread metadata stores
  the remote URL + auth credentials. No channel sprawl.
- **Hrana server already built.** `hrana-server.ts` is the single
  owner of the `.db` file. All local processes already connect
  through it. Only tunnel exposure is needed for remote.
- **OpenCode server basic auth.** Remote OpenCode servers are
  protected with `OPENCODE_SERVER_PASSWORD`. Kimaki generates
  a random password per machine and passes it via the SDK client's
  basic auth header.
- **Bot token = DB auth token.** Remote clients pass
  `KIMAKI_BOT_TOKEN` as their hrana `authToken`. No separate
  JWT key management. Reusing the bot token is fine because
  remotes already need the bot token for Discord REST calls -
  it's the same trust level.
- **Built-in sandbox integrations.** Users don't manually copy
  env vars. Kimaki provides `/new-machine` commands that provision
  environments automatically (see end-user flows below).

## What changes

### 1. `db.ts` + `hrana-server.ts` - already done (Phase 1 complete)

The hrana server is already built and running in-process. All local
OpenCode child processes connect via `KIMAKI_DB_URL=http://127.0.0.1:<lockPort>`.
The bot process uses direct file access via Prisma.

**What remains for remote:**

- Add auth token checking to `hrana-server.ts` for non-localhost requests
  (when accessed via traforo tunnel)
- Start traforo tunnel for the hrana port
- Pass tunnel URL + bot token to remote environments

### 1b. Hrana auth model

```
localhost connections  --> no auth required (today's behavior)
tunnel connections     --> bot token as auth token (new)
```

Add a simple auth check in `createHranaHandler`: if the request
comes through the tunnel (detected by presence of auth header),
validate the token matches the bot token. Localhost requests
continue to be unauthenticated.

The bot token is reused as the auth token because:

- Remote machines already need the bot token for Discord REST
- It's the same trust level (full access to kimaki state)
- No separate JWT key management needed
- Revoking the bot token (regenerating in Discord dev portal)
  invalidates all remote access simultaneously

### 1c. Bootstrap: how remotes get credentials

**Problem:** remote needs DB URL + token + OpenCode auth before it
can connect. Where do these come from?

**Answer:** kimaki generates them locally and provisions them
automatically via built-in integrations. The user never manually
copies env vars.

**Bootstrap flow:**

```
1. Kimaki bot starts
2. Hrana server already running on 127.0.0.1:<lockPort>
3. Starts traforo tunnel for hrana port
   - Tunnel ID persisted in ~/.kimaki/tunnel-id
   - Deterministic URL like kimaki-db-<hash>.traforo.dev
4. Stores tunnel URL in memory for machine provisioning

When user runs /new-machine:
5. Kimaki generates a random OPENCODE_SERVER_PASSWORD
6. Reads bot token + tunnel URL from memory
7. Provisions the remote environment via provider API
   (Vercel API, SSH, etc.) with env vars:
   - KIMAKI_DB_URL=http://kimaki-db-xxx.traforo.dev
   - KIMAKI_DB_TOKEN=<bot-token>
   - KIMAKI_BOT_TOKEN=<bot-token>
   - OPENCODE_SERVER_PASSWORD=<random-password>
8. Remote OpenCode starts with basic auth enabled
9. Kimaki stores remote URL + password in DB (machines table)
10. Creates a Discord thread for the machine
11. Done. User did nothing except run /new-machine.
```

**No chicken-and-egg:** the tunnel URL, bot token, and generated
password are all known locally before any remote connects. The bot
provisions them into the remote environment via the provider's API.

### 2. `opencode.ts` - runtime abstraction (medium)

Today `initializeOpencodeForDirectory` spawns a child process.
For remote machines, it connects to an already-running OpenCode
instance using the stored URL + basic auth credentials.

```ts
// Thread metadata stores machine info:
//   { type: 'local', directory: '/path/to/project' }
//   { type: 'remote', baseUrl: 'https://...', directory: '/remote/path',
//     password: '<random>' }

// For remote, skip spawn, create SDK clients with basic auth
const client = createOpencodeClient({
  baseUrl: remoteUrl,
  // OpenCode server basic auth
  headers: {
    Authorization: `Basic ${btoa(`opencode:${machine.password}`)}`,
  },
})
opencodeServers.set(serverKey, { process: null, client, clientV2, port: 0 })
```

The `opencodeServers` map type expands to allow null process:

```ts
type ServerEntry = {
  process: ChildProcess | null // null for remote
  client: OpencodeClient
  clientV2: OpencodeClientV2
  port: number // 0 for remote
  type: 'local' | 'remote'
  baseUrl: string
}
```

### 3. Hrana tunnel for remote DB access (new)

The hrana server already runs as part of the kimaki boot sequence.
For remote support, add a traforo tunnel to expose it:

```ts
// In cli.ts, after hrana server is started
// Tunnel it for remote access (only if remote features enabled)
const tunnelId = await getOrCreateTunnelId(dataDir)
const tunnelProcess = spawn('kimaki', [
  'tunnel', '-p', String(lockPort), '-t', tunnelId,
])
const tunnelUrl = await waitForTunnelUrl(tunnelProcess)
// tunnelUrl = "https://kimaki-db-xxx.traforo.dev"
// stored in memory for machine provisioning
```

**Lifecycle:** the tunnel is supervised by the kimaki process.
If kimaki exits, the tunnel child process is killed.
The hrana server itself is already in-process and follows
the bot lifecycle.

### 4. OpenCode plugin - no changes needed

The plugin already calls `getPrisma()` which reads `KIMAKI_DB_URL`
from env. It already uses `KIMAKI_BOT_TOKEN` for Discord REST.
The only breaking tool is `kimaki_file_upload` (see section below).

### 5. CLI commands - no changes needed

All CLI commands (`kimaki send`, `upload-to-discord`, `session list`,
etc.) call `getPrisma()` internally. With `KIMAKI_DB_URL` in env,
they connect to sqld over the tunnel. Bot token comes from
`KIMAKI_BOT_TOKEN` env. Everything works.

### 6. Env vars injected into remote OpenCode

These env vars are provisioned automatically by kimaki when
creating a machine thread. The user never sets them manually.

```bash
# Set by kimaki on remote machines:
KIMAKI_DB_URL=http://kimaki-db-xxx.traforo.dev
KIMAKI_DB_TOKEN=<bot-token>   # same as bot token
KIMAKI_BOT_TOKEN=<bot-token>  # for Discord REST in plugin/CLI
KIMAKI_DATA_DIR=/tmp/kimaki   # remote-local temp dir
OPENCODE_SERVER_PASSWORD=<random-per-machine>  # basic auth
# OPENCODE_SERVER_USERNAME defaults to "opencode"
# KIMAKI_LOCK_PORT is NOT set (file upload bridge unavailable)
```

For **local** OpenCode servers (today's behavior), kimaki passes:

```bash
# Set by kimaki on local child processes:
KIMAKI_DB_URL=http://localhost:<lockPort>  # hrana server
# No KIMAKI_DB_TOKEN needed (localhost = no auth)
KIMAKI_BOT_TOKEN=<bot-token>
KIMAKI_DATA_DIR=~/.kimaki
KIMAKI_LOCK_PORT=<port>
# No OPENCODE_SERVER_PASSWORD (local, same machine)
```

## Database schema changes

### New table: `machines`

Machines are thread-scoped, not channel-scoped. A machine record
links a Discord thread to a remote OpenCode server. The parent
channel stays mapped to the local project via `channel_directories`
(unchanged).

```prisma
model machines {
  id              String    @id @default(uuid())
  thread_id       String    @unique    // Discord thread ID
  channel_id      String               // parent project channel
  label           String               // human name like "my-vps"
  provider        String               // "ssh" | "vercel" | "docker"
  remote_url      String               // OpenCode base URL
  remote_directory String              // project path on remote
  password        String               // OPENCODE_SERVER_PASSWORD (random)
  status          String    @default("online")  // "online" | "offline"
  sandbox_id      String?              // provider sandbox ID for cleanup
  created_at      DateTime  @default(now())

  @@index([channel_id])
}
```

`channel_directories` stays **unchanged**. No `runtime_type` or
remote fields on it. Clean separation: channels = local projects,
machine threads = remote.

The `opencodeServers` map in opencode.ts uses a composite key
to avoid collisions between machines with the same path:

```ts
// Key: "local:/Users/dev/app" or "remote:https://vps:7777:/home/app"
const serverKey =
  runtime_type === 'local'
    ? `local:${directory}`
    : `remote:${remote_url}:${directory}`
```

## End-user flows

### Flow 1: `/new-machine` with Vercel sandbox

User wants a cloud sandbox for a task. Zero manual setup.

**In Discord (inside `#myapp` channel):**

```
/new-machine
  provider: vercel
  repo: github.com/user/myapp
  label: sandbox-fix-auth
```

**What happens behind the scenes:**

```
1. Kimaki generates a random OPENCODE_SERVER_PASSWORD
2. Calls Vercel Sandbox API to create environment
   - Clones the repo into the sandbox
   - Injects env vars via Vercel API:
     KIMAKI_DB_URL, KIMAKI_DB_TOKEN, KIMAKI_BOT_TOKEN,
     OPENCODE_SERVER_PASSWORD
   - Starts opencode serve inside the sandbox (basic auth enabled)
   - Returns sandbox URL (e.g. sandbox-abc.vercel.dev:7777)
3. Kimaki creates a Discord thread "sandbox-fix-auth" in #myapp
4. Stores machine record in DB (thread_id, remote_url, password)
5. Creates SDK clients with basic auth against the sandbox URL
6. User types in the thread, sessions route to remote OpenCode
7. Plugin/CLI in sandbox connect to kimaki's hrana via tunnel
8. When done, machine can be destroyed or kept
```

### Flow 2: `/new-machine` with SSH (persistent VPS)

User has a VPS with code at `/home/user/myapp`.

**In Discord (inside `#myapp` channel):**

```
/new-machine
  provider: ssh
  host: my-vps.example.com
  directory: /home/user/myapp
  label: my-vps
```

**What happens:**

```
1. Kimaki generates a random OPENCODE_SERVER_PASSWORD
2. SSHs into the VPS (using configured SSH key)
3. Installs opencode if not present
4. Writes env vars to the remote environment
5. Starts opencode serve with basic auth (via systemd or tuistory)
6. Verifies health endpoint is reachable (with basic auth)
7. Creates Discord thread "my-vps" in #myapp
8. Stores machine record in DB
```

User can also do this from CLI:

```bash
kimaki machine add ssh://root@my-vps.example.com:/home/user/myapp
```

### Flow 3: Machine providers (extensible)

The machine system is provider-agnostic. Each provider implements
a simple interface:

```ts
type MachineProvider = {
  name: string
  create(opts: {
    repo?: string
    directory?: string
    envVars: Record<string, string>
  }): Promise<{ url: string; destroy: () => Promise<void> }>
  healthCheck(url: string, auth: { username: string; password: string }): Promise<boolean>
  destroy(id: string): Promise<void>
}
```

Built-in providers to ship:

- **Vercel Sandbox** - via Vercel API
- **SSH** - for VPS/bare metal (SSH in, install, start)
- **Docker** - spin up a container locally or on a remote host

Future providers (community):

- GitHub Codespace
- Railway
- Fly.io
- AWS CodeCatalyst

### Flow 4: Multiple machines under one project

A team has:

- Mac laptop for local dev (default, no thread needed)
- Linux server for backend testing (remote via SSH)
- GPU machine for ML training (remote via SSH)

```
Discord server:
  #myapp (local project on Mac, today's behavior)
    ├── Thread: "linux-backend" (remote, ssh)
    ├── Thread: "gpu-training" (remote, ssh)
    └── (regular session threads, local)
```

The kimaki bot runs on the Mac. Messages in `#myapp` (and regular
threads) spawn local OpenCode. Messages in machine threads route
to remote OpenCode servers. All share the same hrana DB via
localhost (local) and traforo tunnel (remote).

### Flow 5: Session interaction in a machine thread

User sends "fix the auth bug" in the "linux-backend" thread:

```
1. Discord bot receives message in thread
2. Looks up machines table by thread_id
   -> remote_url = "https://linux-server:7777"
   -> password = "<stored-password>"
3. Instead of spawn(), creates SDK clients with basic auth
4. Calls session.create() + session.prompt() on remote server
5. Subscribes to SSE events from remote server
6. Events flow back: message parts, permissions, questions
7. Bot renders them in Discord as today

Meanwhile on the remote machine:
8. OpenCode runs the AI agent, edits files, runs bash commands
9. Plugin calls getPrisma() -> connects to hrana via tunnel
10. Plugin resolves sessionID -> threadID from DB
11. CLI commands (kimaki send, upload-to-discord) also use tunnel DB
12. Bot token from env lets CLI post to Discord directly
```

Everything works because the DB is the shared coordination layer.

### Flow 6: Ephemeral machine lifecycle

Sandbox machines are temporary. Kimaki tracks their lifecycle:

```
/new-machine provider:vercel repo:user/app label:fix-bug
  -> thread created, machine provisioned
  -> user types in thread, AI works in sandbox
  -> user says "commit and push"
  -> AI pushes to GitHub
  -> user runs /destroy-machine (or sandbox auto-expires)
  -> Kimaki calls provider.destroy()
  -> thread archived, machine record cleaned up
```

Machines that go unreachable (health check fails) are marked
offline in DB. The thread shows a status message. User can
re-provision with `/new-machine` again.

## What doesn't work remotely (and workarounds)

### `kimaki_file_upload` tool

User uploads a file in Discord -> bot downloads to kimaki host ->
returns local path. Remote OpenCode can't read that path.

**Workaround options (pick one for v1):**

1. **Disable for remote** - return "file upload not available for
   remote machines" if `KIMAKI_LOCK_PORT` is not set (already
   gracefully handled in plugin code)
2. **Return Discord CDN URL** - instead of downloading to disk,
   return the Discord attachment URL. OpenCode can fetch it
3. **Upload via bridge** - bot downloads file, POSTs content to
   remote OpenCode's HTTP endpoint, returns remote path

Option 1 is simplest for v1. Option 2 is cleanest long-term.

### `fs.existsSync(projectDirectory)` validation

Bot validates directory exists before starting session. For machine
threads, the directory is on another machine.

**Fix:** Skip validation when thread is a machine thread (check
machines table). Use OpenCode health endpoint (with basic auth)
instead.

### Worktree creation from bot

Bot calls `createWorktreeWithSubmodules()` which runs git commands
with `cwd: directory`. For machine threads, this fails.

**Fix:** For machine threads, send worktree creation as a prompt
to the remote OpenCode session itself (the AI agent runs git on
the remote machine). Or disable auto-worktrees for machine threads.

### `/run-shell-command` and `!` prefix

These run `execAsync()` with `cwd: directory` on the kimaki host.
For machine threads, the directory doesn't exist locally.

**Fix:** Route shell commands through the remote OpenCode server's
bash tool, or disable for machine threads in v1.

### `/restart-opencode-server`

Kills and respawns the child process. No child process for remote.

**Fix:** For machine threads, call health endpoint (with basic auth)
or show "restart not available for remote machines, restart manually
on the remote host".

## Security considerations

### Two-layer auth model

Two secrets protect remote access:

1. **Bot token** - serves as DB auth token (hrana tunnel) and
   Discord REST authentication. One token to revoke.
2. **Per-machine password** - random string generated by kimaki,
   stored in the `machines` table, used as `OPENCODE_SERVER_PASSWORD`.
   Each machine has its own password. Revoking one machine doesn't
   affect others.

Regenerating the bot token in Discord dev portal invalidates all
remote DB access simultaneously. Destroying a machine record
invalidates that machine's OpenCode server auth.

### DB exposure via tunnel

The hrana server exposes the full database over the traforo tunnel.
The database contains bot tokens and API keys. Mitigations:

- **Bot token required** for tunnel connections (already needed)
- **traforo tunnel URL** is not publicly discoverable (random
  subdomain, no DNS record)
- **Localhost is unauthenticated** but only reachable from the
  kimaki host itself
- **Machine providers are trusted** - kimaki provisions env vars
  into them via authenticated provider APIs (Vercel API, SSH)

### OpenCode server exposure

Remote OpenCode servers listen on public ports but are protected
by `OPENCODE_SERVER_PASSWORD` (HTTP basic auth). Only kimaki
knows the password (stored in DB). The password is randomly
generated per machine and never shown to the user.

### Trust boundary

```
Trusted:
- Kimaki host (runs bot, hrana server, local OpenCode)
- Remote machines explicitly added by user via /new-machine
- Sandbox environments provisioned by kimaki

Untrusted:
- Everything else (internet, other Discord users without role)
```

Remote OpenCode servers are trusted to run arbitrary code. The
user explicitly adds them via `/new-machine`.
This is the same trust level as running OpenCode locally.

## Implementation phases

### Phase 1: hrana tunnel + auth (DONE partially, ~1 day remaining)

- ~~Start hrana server alongside kimaki bot~~ (**done**: `hrana-server.ts`)
- ~~All local processes connect via http URL~~ (**done**: `KIMAKI_DB_URL`)
- Add auth token checking to hrana handler for non-localhost requests
- Start traforo tunnel for hrana port in cli.ts
- Persist tunnel ID in `~/.kimaki/tunnel-id`
- Test: remote process connects to hrana via tunnel with bot token

### Phase 2: `/new-machine` command + machines table (2-3 days)

- Add `machines` prisma model (thread_id, remote_url, password, etc.)
- Run `pnpm generate` to update schema
- Add `/new-machine` slash command with provider + label options
- Generate random `OPENCODE_SERVER_PASSWORD` per machine
- Store machine record in DB, create Discord thread
- Modify `initializeOpencodeForDirectory` to check machines table
  when message is in a thread → connect with basic auth to remote URL
- Use composite key for opencodeServers map
- Skip `fs.existsSync` for machine threads
- Health check with basic auth for remote servers

### Phase 3: session routing for machines (1-2 days)

- In discord-bot.ts message handler, check if thread is a machine thread
- Create SDK clients with basic auth headers from stored password
- SSE event subscription works identically (just different base URL)
- Permission/question replies route to correct server
- Test: send message in machine thread, get AI response

### Phase 4: CLI + plugin verification (1 day)

- Verify `kimaki send`, `upload-to-discord`, `session list` work
  with `KIMAKI_DB_URL` set to tunnel URL
- Verify plugin tools work (mark thread, archive, list users)
- Disable `kimaki_file_upload` for remote (graceful error message)
- Test: AI agent in remote session uses kimaki CLI successfully

### Phase 5: machine providers (3-5 days)

- Define `MachineProvider` interface
- Implement Vercel sandbox provider (via API)
- Implement SSH provider (for VPS/bare metal)
- `/new-machine` auto-provisions based on selected provider
- Machine lifecycle management (create, health check, destroy)
- Auto-provision all env vars (DB URL, tokens, password)

### Phase 6: UX polish (1-2 days)

- Health check monitoring for machines (periodic ping with basic auth)
- Show online/offline status in thread
- `/destroy-machine` command
- SSE reconnect logic for remote sessions (WAN blips)
- Graceful degradation when hrana tunnel is down

## Total estimated effort

- **Phase 1 (hrana tunnel + auth):** ~1 day (most is already done)
- **Phases 1-4 (remote sessions work):** ~6 days
- **Full version with providers (all phases):** ~2 weeks
- **Risk:** medium (SSE over WAN, provider APIs, basic auth in SDK)
