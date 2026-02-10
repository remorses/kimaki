---
title: Remote OpenCode Servers
description: |
  Architecture plan for supporting remote OpenCode servers in Kimaki.
  Allows projects on different machines (dev servers, VPS, Vercel sandbox,
  CI runners) to be controlled from the same Discord server.
prompt: |
  Based on deep analysis of all communication paths between database,
  OpenCode servers, OpenCode plugin, and kimaki process. Key files read:
  opencode.ts, opencode-plugin.ts, db.ts, database.ts, session-handler.ts,
  discord-bot.ts, system-message.ts, commands/permissions.ts,
  commands/ask-question.ts, commands/file-upload.ts, discord-utils.ts,
  interaction-handler.ts, tools.ts, schema.prisma, cli.ts.
  Oracle agent consulted for plan review.
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

The key insight: **we already use `@prisma/adapter-libsql`** which
supports both `file:` and `libsql://` URLs. By running a libsql HTTP
server (`sqld`) locally and tunneling it via traforo, remote OpenCode
processes can access the same database over the network.

**All processes go through sqld** - it is the single owner of the
SQLite file. This avoids dual-writer issues (two processes opening
the same `.db` file). Local processes connect via localhost (no auth),
remote processes connect via traforo tunnel (bot token as auth).

```
┌──────────────────────────────────────────────────────┐
│                  Kimaki Host                          │
│                                                       │
│  ┌──────────────┐                                    │
│  │ Discord Bot   │──┐  libsql://localhost:8080       │
│  │ (session-     │  │  (no auth on localhost)        │
│  │  handler,     │  │                                 │
│  │  interactions)│  │                                 │
│  └──────────────┘  │  ┌─────────────────────────┐   │
│                     ├─>│ sqld (libsql server)     │   │
│  ┌──────────────┐  │  │ single owner of .db file │   │
│  │ Local OpenCode│──┘  │ localhost = no auth      │   │
│  │ Server        │     │ tunnel = bot token auth  │   │
│  │ (child proc)  │     └────────────┬────────────┘   │
│  └──────────────┘           ┌───────┴──────────┐     │
│                              │ traforo tunnel   │     │
│                              └───────┬──────────┘     │
└──────────────────────────────────────┼───────────────┘
                                       │ internet
                    ┌──────────────────┼─────────────┐
                    │  Remote Machine   │             │
                    │                   v             │
                    │  ┌──────────────────────────┐  │
                    │  │ OpenCode Server           │  │
                    │  │ (standalone, not child)   │  │
                    │  │                           │  │
                    │  │ env:                      │  │
                    │  │  KIMAKI_DB_URL=libsql://  │  │
                    │  │    kimaki-db.traforo.dev  │  │
                    │  │  KIMAKI_DB_TOKEN=<bot_tk> │  │
                    │  │  KIMAKI_BOT_TOKEN=<same>  │  │
                    │  └──────────────────────────┘  │
                    │         │                       │
                    │         v                       │
                    │  ┌──────────────────────────┐  │
                    │  │ Plugin + CLI              │  │
                    │  │ getPrisma() ->            │  │
                    │  │   libsql://tunnel URL     │  │
                    │  │ Discord REST -> direct    │  │
                    │  └──────────────────────────┘  │
                    └────────────────────────────────┘
```

**Key design decisions:**

- **Single sqld process** owns the `.db` file. No process opens
  the SQLite file directly. This avoids WAL mode dual-writer
  issues and lock contention between local processes.
- **No auth on localhost.** sqld listens on `127.0.0.1` without
  auth. Bot and local OpenCode connect with just the URL.
- **Bot token = DB auth token.** Remote clients pass
  `KIMAKI_BOT_TOKEN` as their sqld `authToken`. No separate
  JWT key management. Reusing the bot token is fine because
  remotes already need the bot token for Discord REST calls -
  it's the same trust level.
- **Built-in sandbox integrations.** Users don't manually copy
  env vars. Kimaki provides `/sandbox` commands that provision
  environments automatically (see end-user flows below).

## What changes

### 1. `db.ts` - all processes go through sqld

Today `db.ts` opens the SQLite file directly with `file:` URL.
With this change, **all processes** connect through sqld instead:

```ts
// Before (direct file access)
const adapter = new PrismaLibSql({ url: `file:${dbPath}` })

// After (always through sqld)
const dbUrl = process.env.KIMAKI_DB_URL || 'http://localhost:8080'
const adapter = new PrismaLibSql({
  url: dbUrl,
  // Bot token as auth - only needed for remote (tunnel) URLs.
  // Localhost sqld runs without auth, but passing token is harmless.
  authToken: process.env.KIMAKI_DB_TOKEN,
})
```

Schema migrations run once at sqld startup (the bot process does
this before accepting connections). Remote clients skip migrations:

```ts
const isRemote =
  process.env.KIMAKI_DB_URL && !process.env.KIMAKI_DB_URL.includes('localhost')
if (!isRemote) {
  await migrateSchema(prisma)
}
```

### 1b. sqld auth model

```
localhost connections  --> no auth required
tunnel connections     --> bot token as auth token
```

sqld is configured to skip auth for localhost and require a token
for external connections via the traforo tunnel. The bot token is
reused as the auth token because:

- Remote machines already need the bot token for Discord REST
- It's the same trust level (full access to kimaki state)
- No separate JWT key management needed
- Revoking the bot token (regenerating in Discord dev portal)
  invalidates all remote access simultaneously

### 1c. Bootstrap: how remotes get credentials

**Problem:** remote needs DB URL + token before it can connect.
Where do these come from?

**Answer:** kimaki generates them locally and provisions them
automatically via built-in sandbox integrations. The user never
manually copies env vars.

**Bootstrap flow:**

```
1. Kimaki bot starts
2. Starts sqld on localhost:8080 serving discord-sessions.db
3. Starts traforo tunnel for sqld port
   - Tunnel ID persisted in ~/.kimaki/tunnel-id
   - Deterministic URL like kimaki-db-<hash>.traforo.dev
4. Stores tunnel URL in memory for sandbox provisioning

When user runs /sandbox or /add-remote-project:
5. Kimaki reads bot token from DB + tunnel URL from memory
6. Provisions the remote environment via provider API
   (Vercel API, SSH, etc.) with env vars:
   - KIMAKI_DB_URL=libsql://kimaki-db-xxx.traforo.dev
   - KIMAKI_DB_TOKEN=<bot-token>
   - KIMAKI_BOT_TOKEN=<bot-token>
7. Remote OpenCode starts, getPrisma() connects via tunnel
8. Done. User did nothing except click a Discord command.
```

**No chicken-and-egg:** the tunnel URL and bot token are both
known locally before any remote connects. The bot provisions
them into the remote environment via the provider's API.

### 2. `opencode.ts` - runtime abstraction (medium)

Today `initializeOpencodeForDirectory` spawns a child process.
For remote servers, it connects to an already-running OpenCode
instance.

```ts
// New: remote server registry in channel_directories or new table
// channel maps to either:
//   { type: 'local', directory: '/path/to/project' }
//   { type: 'remote', baseUrl: 'https://...', directory: '/remote/path' }

// For remote, skip spawn, just create SDK clients
const client = createOpencodeClient({ baseUrl: remoteUrl })
const clientV2 = createOpencodeClientV2({ baseUrl: remoteUrl })
opencodeServers.set(directory, { process: null, client, clientV2, port: 0 })
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

### 3. sqld startup alongside kimaki (new)

sqld starts as part of the kimaki boot sequence, before the bot
connects to Discord. It is the single owner of the `.db` file.

```ts
// In cli.ts, during bot startup (before initDatabase)
const dbPath = path.join(dataDir, 'discord-sessions.db')
const sqldProcess = spawn('sqld', [
  '--db-path',
  dbPath,
  '--http-listen-addr',
  '127.0.0.1:8080',
  // No --auth flag: localhost connections are unauthenticated.
  // Auth is enforced at the traforo tunnel layer for remote.
])
await waitForSqld(8080)

// Tunnel it for remote access (only if remote features enabled)
const tunnelId = await getOrCreateTunnelId(dataDir)
const tunnelProcess = spawn('kimaki', ['tunnel', '-p', '8080', '-t', tunnelId])
const tunnelUrl = await waitForTunnelUrl(tunnelProcess)
// tunnelUrl = "https://kimaki-db-xxx.traforo.dev"
// stored in memory for sandbox provisioning
```

**Lifecycle:** sqld is supervised by the kimaki process. If sqld
crashes, kimaki restarts it. If kimaki exits, sqld is killed
(child process). The tunnel follows the same lifecycle.

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
creating a sandbox or adding a remote project. The user never
sets them manually.

```bash
# Set by kimaki on remote machines:
KIMAKI_DB_URL=libsql://kimaki-db-xxx.traforo.dev
KIMAKI_DB_TOKEN=<bot-token>   # same as bot token
KIMAKI_BOT_TOKEN=<bot-token>  # for Discord REST in plugin/CLI
KIMAKI_DATA_DIR=/tmp/kimaki   # remote-local temp dir
# KIMAKI_LOCK_PORT is NOT set (file upload bridge unavailable)
```

For **local** OpenCode servers (today's behavior), kimaki passes:

```bash
# Set by kimaki on local child processes:
KIMAKI_DB_URL=http://localhost:8080   # sqld on same machine
# No KIMAKI_DB_TOKEN needed (localhost = no auth)
KIMAKI_BOT_TOKEN=<bot-token>
KIMAKI_DATA_DIR=~/.kimaki
KIMAKI_LOCK_PORT=<port>
```

## Database schema changes

### Modified: `channel_directories`

Add fields for remote runtime support. Single source of truth
(no separate `remote_servers` table to avoid drift):

```prisma
model channel_directories {
  channel_id    String    @id
  directory     String           // local path OR remote path
  channel_type  String
  app_id        String?
  runtime_type  String   @default("local")  // "local" | "remote"
  remote_url    String?          // OpenCode base URL if remote
  remote_label  String?          // human name like "my-vps"
  remote_status String?          // "online" | "offline" | null
  sandbox_id    String?          // provider sandbox ID for cleanup
  sandbox_provider String?       // "vercel" | "ssh" | "docker"
  created_at    DateTime? @default(now())
  // ... existing relations unchanged
}
```

For local channels: `runtime_type = "local"`, other remote fields
are null. Fully backward compatible.

For remote channels: `runtime_type = "remote"`,
`remote_url = "https://..."`, `directory = "/remote/path"`.

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

### Flow 1: Vercel sandbox (built-in integration)

User wants a cloud sandbox for a task. Zero manual setup.

**In Discord:**

```
/sandbox vercel
  repo: github.com/user/myapp
  prompt: "Fix the auth middleware bug"
```

**What happens behind the scenes:**

```
1. Kimaki calls Vercel Sandbox API to create environment
   - Clones the repo into the sandbox
   - Injects env vars via Vercel API:
     KIMAKI_DB_URL, KIMAKI_DB_TOKEN, KIMAKI_BOT_TOKEN
   - Starts opencode serve inside the sandbox
   - Returns sandbox URL (e.g. sandbox-abc.vercel.dev:7777)
2. Kimaki creates a Discord thread for the task
3. Stores channel -> remote server mapping in DB
4. Creates SDK clients against the sandbox URL
5. Starts the session with the user's prompt
6. AI agent works in the sandbox, edits files, runs commands
7. Plugin/CLI in sandbox connect to kimaki's sqld via tunnel
8. When done, sandbox can be destroyed or kept
```

The user just ran one command. Kimaki handled provisioning,
env configuration, and session creation.

### Flow 2: Other sandbox providers (extensible)

The sandbox system is provider-agnostic. Each provider implements
a simple interface:

```ts
type SandboxProvider = {
  name: string
  create(opts: {
    repo?: string
    directory?: string
    envVars: Record<string, string>
  }): Promise<{ url: string; destroy: () => Promise<void> }>
  healthCheck(url: string): Promise<boolean>
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

### Flow 3: Adding a remote machine (SSH provider)

User has a VPS with code at `/home/user/myapp`.

**In Discord:**

```
/add-remote-project
  provider: ssh
  host: my-vps.example.com
  directory: /home/user/myapp
  label: my-vps-app
```

**What happens:**

```
1. Kimaki SSHs into the VPS (using configured SSH key)
2. Installs opencode + kimaki if not present
3. Writes env vars to ~/.kimaki/remote-env on the VPS
4. Starts opencode serve (via systemd unit or tmux)
5. Verifies health endpoint is reachable
6. Creates Discord channel #my-vps-app
7. Stores remote server mapping in DB
```

User can also do this from CLI:

```bash
kimaki remote add ssh://root@my-vps.example.com:/home/user/myapp
```

### Flow 4: Multiple machines, same Discord server

A team has:

- Mac laptop for frontend (local)
- Linux server for backend (remote via SSH)
- GPU machine for ML training (remote via SSH)

```
Discord server:
  #frontend      -> local (Mac, today's behavior)
  #backend       -> remote (Linux, ssh provider)
  #ml-training   -> remote (GPU, ssh provider)
```

The kimaki bot runs on the Mac. It spawns OpenCode locally for
`#frontend` and connects to remote OpenCode servers for the
other two. All three share the same sqld database via localhost
(local) and traforo tunnel (remote).

### Flow 5: Session interaction with remote server

User sends "fix the auth bug" in `#backend` channel:

```
1. Discord bot receives message
2. Looks up channel_directories -> runtime_type = "remote",
   remote_url = "https://linux-server:7777"
3. Instead of spawn(), creates SDK clients against remote URL
4. Calls session.create() + session.prompt() on remote server
5. Subscribes to SSE events from remote server
6. Events flow back: message parts, permissions, questions
7. Bot renders them in Discord as today

Meanwhile on the remote machine:
8. OpenCode runs the AI agent, edits files, runs bash commands
9. Plugin calls getPrisma() -> connects to sqld via tunnel
10. Plugin resolves sessionID -> threadID from DB
11. CLI commands (kimaki send, upload-to-discord) also use tunnel DB
12. Bot token from env lets CLI post to Discord directly
```

Everything works because the DB is the shared coordination layer.

### Flow 6: Ephemeral sandbox lifecycle

Sandboxes are temporary. Kimaki tracks their lifecycle:

```
/sandbox vercel repo:user/app prompt:"fix bug"
  -> sandbox created, session starts
  -> AI works, user reviews
  -> user says "commit and push"
  -> AI pushes to GitHub
  -> user runs /sandbox destroy (or sandbox auto-expires)
  -> Kimaki calls provider.destroy()
  -> channel/thread archived
```

Sandboxes that go unreachable (health check fails) are marked
offline in DB. The channel shows a status message. User can
re-provision with `/sandbox recreate`.

## What doesn't work remotely (and workarounds)

### `kimaki_file_upload` tool

User uploads a file in Discord -> bot downloads to kimaki host ->
returns local path. Remote OpenCode can't read that path.

**Workaround options (pick one for v1):**

1. **Disable for remote** - return "file upload not available for
   remote servers" if `KIMAKI_LOCK_PORT` is not set (already
   gracefully handled in plugin code)
2. **Return Discord CDN URL** - instead of downloading to disk,
   return the Discord attachment URL. OpenCode can fetch it
3. **Upload via bridge** - bot downloads file, POSTs content to
   remote OpenCode's HTTP endpoint, returns remote path

Option 1 is simplest for v1. Option 2 is cleanest long-term.

### `fs.existsSync(projectDirectory)` validation

Bot validates directory exists before starting session. For remote
servers, the directory is on another machine.

**Fix:** Skip validation when `runtime_type === 'remote'`. Use
OpenCode health endpoint instead.

### Worktree creation from bot

Bot calls `createWorktreeWithSubmodules()` which runs git commands
with `cwd: directory`. For remote projects, this fails.

**Fix:** For remote runtimes, send worktree creation as a prompt
to the remote OpenCode session itself (the AI agent runs git on
the remote machine). Or disable auto-worktrees for remote channels.

### `/run-shell-command` and `!` prefix

These run `execAsync()` with `cwd: directory` on the kimaki host.
For remote projects, the directory doesn't exist locally.

**Fix:** Route shell commands through the remote OpenCode server's
bash tool, or disable for remote channels in v1.

### `/restart-opencode-server`

Kills and respawns the child process. No child process for remote.

**Fix:** For remote, call health endpoint or show "restart not
available for remote servers, restart manually on the remote host".

## Security considerations

### Single token model

The bot token is the only secret. It serves as:

- Discord REST API authentication (plugin, CLI)
- sqld auth token for remote DB access via tunnel
- Trust credential for sandbox provisioning

This simplifies the security model: **one token to manage, one
token to revoke.** Regenerating the bot token in Discord dev
portal invalidates all remote access simultaneously.

### DB exposure via tunnel

sqld exposes the full database over the traforo tunnel. The
database contains bot tokens and API keys. Mitigations:

- **Bot token required** for tunnel connections (already needed)
- **traforo tunnel URL** is not publicly discoverable (random
  subdomain, no DNS record)
- **Localhost is unauthenticated** but only reachable from the
  kimaki host itself
- **Sandbox providers are trusted** - kimaki provisions env vars
  into them via authenticated provider APIs (Vercel API, SSH)

### Trust boundary

```
Trusted:
- Kimaki host (runs bot, sqld, local OpenCode)
- Remote machines explicitly added by user
- Sandbox environments provisioned by kimaki

Untrusted:
- Everything else (internet, other Discord users without role)
```

Remote OpenCode servers are trusted to run arbitrary code. The
user explicitly adds them via `/add-remote-project` or `/sandbox`.
This is the same trust level as running OpenCode locally.

## Implementation phases

### Phase 1: sqld as single DB owner (2-3 days)

- Start sqld alongside kimaki bot in cli.ts (before initDatabase)
- Change db.ts: all processes connect via `libsql://` URL
  - Local: `http://localhost:8080` (no auth)
  - Remote: tunnel URL (bot token as auth)
- Run migrations through sqld on startup
- Start traforo tunnel for sqld port
- Pass `KIMAKI_DB_URL=http://localhost:8080` to local OpenCode
- Test: local setup works identically through sqld

### Phase 2: remote server registration (2-3 days)

- Add `runtime_type` + `remote_url` to channel_directories
- Add `/add-remote-project` slash command
- Modify `initializeOpencodeForDirectory` to handle remote URLs
  - Use composite key for opencodeServers map (not just directory)
- Skip `fs.existsSync` for remote channels
- Disable worktree auto-creation for remote channels
- Health check endpoint for remote servers

### Phase 3: session routing for remote (1-2 days)

- Modify session-handler.ts to use remote SDK clients
- SSE event subscription works identically (just different base URL)
- Permission/question replies route to correct server
- Test: send message in remote channel, get AI response

### Phase 4: CLI + plugin verification (1 day)

- Verify `kimaki send`, `upload-to-discord`, `session list` work
  with `KIMAKI_DB_URL` set to tunnel URL
- Verify plugin tools work (mark thread, archive, list users)
- Disable `kimaki_file_upload` for remote (graceful error message)
- Test: AI agent in remote session uses kimaki CLI successfully

### Phase 5: sandbox integrations (3-5 days)

- Define `SandboxProvider` interface
- Implement Vercel sandbox provider (via API)
- Implement SSH provider (for VPS/bare metal)
- Add `/sandbox` slash command with provider selection
- Sandbox lifecycle management (create, health check, destroy)
- Auto-provision env vars into sandbox environments

### Phase 6: UX polish (1-2 days)

- Health check monitoring for remote servers (periodic ping)
- Show online/offline status in Discord channel topic
- `/remove-remote-project` and `/sandbox destroy` commands
- SSE reconnect logic for remote sessions (WAN blips)
- Graceful degradation when sqld/tunnel is down

## Total estimated effort

- **Phase 1 only (sqld migration):** ~2-3 days
- **Phases 1-4 (remote sessions work):** ~8 days
- **Full version with sandboxes (all phases):** ~2-3 weeks
- **Risk:** medium (sqld reliability, SSE over WAN, provider APIs)
