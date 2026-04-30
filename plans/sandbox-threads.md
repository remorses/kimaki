---
title: Sandbox Threads
description: |
  Architecture plan for thread-scoped sandbox sessions in Kimaki.
  Sandboxes are reusable cloud environments (Vercel, Daytona, etc.)
  that any thread can attach to. Replaces channel-scoped sandbox model
  from remote-opencode-servers.md with a more flexible thread-scoped
  approach. Sandboxes are first-class persistent objects that threads
  connect to, not ephemeral per-session resources.
prompt: |
  User wanted thread-scoped sandboxes instead of channel-scoped.
  Sandboxes should be reusable across threads. User can start a
  thread on an existing sandbox or create a new one. Providers are
  pluggable (Vercel, Daytona, SSH). Researched @vercel/sandbox and
  @daytonaio/sdk npm packages. Key files read: opencode.ts,
  schema.prisma, database.ts, session-handler.ts, cli.ts,
  commands/worktree.ts, discord-utils.ts. Builds on top of the
  remote-opencode-servers.md plan (sqld + tunnel infrastructure).
---

# Sandbox Threads

## Core idea

Sandboxes are **persistent, reusable cloud environments** that exist
independently of any single thread. A thread can be started "on" an
existing sandbox, or a new sandbox can be created for it. Multiple
threads can use the same sandbox sequentially or concurrently. This
is the same mental model as worktrees today — a thread is optionally
attached to a sandbox.

## How the user interacts

### Discord slash commands

**`/sandbox` — start a thread on a sandbox**

```
/sandbox
  provider: vercel | daytona       (optional, uses default)
  sandbox: my-frontend-sandbox     (optional, pick existing)
  repo: github.com/user/app        (optional, for new sandbox)
  prompt: "Fix the auth bug"       (optional, starts session)
```

Behavior:

- If `sandbox` is provided: reuse that sandbox, create thread
- If `sandbox` is omitted: create a new sandbox, create thread
- Autocomplete on `sandbox` field shows existing sandboxes for
  this channel's provider with their status (running/stopped)

**`/sandbox-list` — see all sandboxes**

Shows a table of all registered sandboxes: name, provider, status,
last used, linked threads count.

**`/sandbox-destroy` — remove a sandbox**

Calls provider.destroy(), removes DB record, archives any linked
threads that are still open.

**`/sandbox-connect` — connect current thread to a sandbox**

For threads already open. Switches the thread's runtime from local
to the selected sandbox. Like `/sandbox` but without creating a new
thread.

### `kimaki send` CLI

```bash
# Create new sandbox + thread
kimaki send --channel 123 --new-sandbox \
  --prompt 'Fix the auth bug' \
  --sandbox-provider vercel \
  --sandbox-repo github.com/user/app

# Reuse existing sandbox
kimaki send --channel 123 --sandbox my-frontend-sandbox \
  --prompt 'Continue fixing the auth bug'

# Shorthand: just --sandbox with a name that doesn't exist yet
# → creates it (if --sandbox-provider is also given)
```

Flags:

- `--sandbox <name>` — attach thread to existing sandbox by name
- `--new-sandbox` — always create a fresh sandbox
- `--sandbox-provider <provider>` — which provider (default from
  channel config or global setting)
- `--sandbox-repo <url>` — git repo to clone into new sandbox
- `--sandbox-snapshot <id>` — create from a saved snapshot

### `kimaki sandbox` CLI subcommand

```bash
kimaki sandbox list                # list all sandboxes
kimaki sandbox create              # create sandbox interactively
kimaki sandbox destroy <name>      # destroy + cleanup
kimaki sandbox stop <name>         # stop (save resources)
kimaki sandbox start <name>        # restart a stopped sandbox
kimaki sandbox snapshot <name>     # save state for fast resume
```

## Provider SDK comparison

### Vercel (`@vercel/sandbox`)

```
npm: @vercel/sandbox
Auth: Vercel OIDC token (vercel link + vercel env pull) or access token
```

| Operation     | Method                                                         | Notes                         |
| ------------- | -------------------------------------------------------------- | ----------------------------- |
| Create        | `Sandbox.create({ runtime, source, ports, timeout })`          | 2-3s cold start               |
| Reconnect     | `Sandbox.get({ sandboxId })`                                   | 0.3s, must be running         |
| Run command   | `sandbox.runCommand({ cmd, args })`                            | Returns exit code + stdout    |
| Write file    | `sandbox.writeFile(path, content)`                             | Writes as vercel-sandbox user |
| Get domain    | `sandbox.domain(port)`                                         | Public HTTPS URL for a port   |
| Snapshot      | `sandbox.snapshot()`                                           | Stops sandbox, saves state    |
| From snapshot | `Sandbox.create({ source: { type: 'snapshot', snapshotId } })` | Fast resume                   |
| Stop          | `sandbox.stop()`                                               | Explicit cleanup              |
| List          | `Sandbox.list({ projectId })`                                  | Paginated                     |

Key properties:

- `sandbox.sandboxId` — unique ID (string like `sbx_abc123`)
- `sandbox.status` — `pending | running | stopping | stopped | failed`
- Snapshots persist 7 days, sandboxes timeout after 5-45min (plan-dependent)
- Runs Amazon Linux 2023 with sudo, Firecracker microVM isolation
- Runtimes: `node24`, `node22`, `python3.13`

Reuse model: `Sandbox.get()` reconnects to a running sandbox.
For stopped sandboxes, use snapshots: `snapshot()` then
`create({ source: { type: 'snapshot', snapshotId } })`.

### Daytona (`@daytonaio/sdk`)

```
npm: @daytonaio/sdk
Auth: API key from Daytona Dashboard
```

| Operation   | Method                                                   | Notes                       |
| ----------- | -------------------------------------------------------- | --------------------------- |
| Create      | `daytona.create({ language, envVars, resources })`       | Configurable                |
| Get by ID   | `daytona.get(sandboxId)`                                 | Works for any state         |
| Run command | `sandbox.process.executeCommand(cmd)`                    | Returns result string       |
| Run code    | `sandbox.process.codeRun(code)`                          | Direct code execution       |
| File ops    | `sandbox.fs.uploadFile()`, `.list()`, etc.               | Full filesystem API         |
| Start       | `sandbox.start(timeout)`                                 | Resume stopped sandbox      |
| Stop        | `daytona.stop(sandbox)`                                  | Preserves state             |
| Archive     | `sandbox.archive()`                                      | Cold storage, slower resume |
| Remove      | `daytona.remove(sandbox)`                                | Permanent deletion          |
| List        | `daytona.list()`                                         | All sandboxes               |
| Snapshot    | Image-based snapshots via `CreateSandboxFromImageParams` | Custom Docker images        |

Key properties:

- `sandbox.id` — unique ID
- `sandbox.instance.state` — running/stopped/archived/etc.
- `autoStopInterval` — minutes of inactivity before auto-stop (default 15)
- `autoArchiveInterval`, `autoDeleteInterval` — lifecycle management
- Supports Python, TypeScript, JavaScript, Go, Ruby runtimes
- Has LSP support for code intelligence
- SSH access via `sandbox.createSshAccess()`

Reuse model: `daytona.get(id)` returns sandbox in any state.
Call `sandbox.start()` to resume a stopped one. No separate
snapshot dance needed — stopped sandboxes preserve filesystem.

### Provider abstraction

```ts
interface SandboxProvider {
  name: string

  create(opts: {
    repo?: string
    envVars: Record<string, string>
    label?: string
    snapshotId?: string
  }): Promise<{
    sandboxId: string
    // base URL where opencode serve is running
    baseUrl: string
    status: string
  }>

  // Reconnect to an existing sandbox. Starts it if stopped.
  resume(sandboxId: string): Promise<{
    baseUrl: string
    status: string
  }>

  stop(sandboxId: string): Promise<void>
  destroy(sandboxId: string): Promise<void>
  snapshot(sandboxId: string): Promise<{ snapshotId: string }>

  healthCheck(sandboxId: string): Promise<{
    status: 'running' | 'stopped' | 'archived' | 'unknown'
  }>
}
```

Each provider implements this interface. The `create` method is
responsible for:

1. Provisioning the environment
2. Cloning the repo if provided
3. Installing opencode
4. Starting `opencode serve` on a port
5. Returning the base URL where the opencode API is reachable

The `resume` method handles provider-specific resurrection:

- Vercel: tries `Sandbox.get()`, falls back to snapshot-based create
- Daytona: calls `sandbox.start()` on stopped sandboxes

## Database schema

### New table: `sandboxes`

```prisma
model sandboxes {
  id                String    @id @default(uuid())
  name              String    @unique
  provider          String              // "vercel" | "daytona" | "ssh"
  provider_sandbox_id String            // provider's native ID
  status            String    @default("creating")
                                        // creating | running | stopped |
                                        // archived | failed | destroyed
  base_url          String?             // opencode API URL when running
  snapshot_id       String?             // last snapshot ID (provider-native)
  repo_url          String?             // git repo cloned into sandbox
  label             String?             // human description
  channel_id        String?             // channel that "owns" this sandbox
  last_used_at      DateTime? @default(now())
  created_at        DateTime? @default(now())
  updated_at        DateTime? @default(now()) @updatedAt

  thread_sandboxes  thread_sandboxes[]

  @@index([channel_id, status])
  @@index([provider, status])
}
```

### New table: `thread_sandboxes`

Links a thread to a sandbox (same pattern as `thread_worktrees`):

```prisma
model thread_sandboxes {
  thread_id   String    @id
  sandbox_id  String
  created_at  DateTime? @default(now())

  thread  thread_sessions @relation(fields: [thread_id], references: [thread_id])
  sandbox sandboxes       @relation(fields: [sandbox_id], references: [id])
}
```

### New table: `sandbox_providers`

User-configured provider credentials:

```prisma
model sandbox_providers {
  id          String    @id @default(uuid())
  provider    String              // "vercel" | "daytona"
  label       String?             // user-facing name
  api_key     String?             // encrypted provider API key
  config_json String?             // provider-specific config (JSON)
  is_default  Int       @default(0)
  app_id      String?
  created_at  DateTime? @default(now())
  updated_at  DateTime? @default(now()) @updatedAt

  bot bot_tokens? @relation(fields: [app_id], references: [app_id])

  @@unique([provider, app_id])
}
```

## Architecture: how sandboxes run opencode

The sandbox needs to run an opencode server that kimaki can talk to.
Two approaches, depending on provider capabilities:

### Approach A: opencode inside sandbox (Daytona, SSH)

Daytona and SSH providers give full VM/container access. We install
opencode inside the sandbox and run `opencode serve --port 7777`.

```
Kimaki Host                    Daytona/SSH Sandbox
┌──────────────┐              ┌──────────────────┐
│ Discord Bot   │──SDK HTTP──>│ opencode serve   │
│               │<──SSE──────│ port 7777         │
│               │             │                   │
│ sqld (DB)     │<──tunnel───│ plugin/CLI        │
└──────────────┘              │ (DB via tunnel)   │
                              └──────────────────┘
```

The sandbox has a public URL or tunneled port. Kimaki connects to
it the same way it would connect to any remote opencode server
(from the remote-opencode-servers plan).

### Approach B: opencode on kimaki host, sandbox as tool (Vercel)

Vercel sandboxes are ephemeral microVMs with limited lifetime
(5-45 min). Running opencode inside them is fragile. Instead:

**Run opencode locally. Give the AI agent sandbox access as tools.**

```
Kimaki Host
┌──────────────────────────────────────┐
│ Discord Bot                           │
│    │                                  │
│    v                                  │
│ opencode serve (local)                │
│    │                                  │
│    v                                  │
│ AI agent uses sandbox tools:          │
│   - sandbox_run_command(cmd)          │
│   - sandbox_write_file(path, content) │
│   - sandbox_read_file(path)           │
│   - sandbox_get_url(port)             │
│    │                                  │
│    v                                  │
│ MCP tools call @vercel/sandbox SDK    │──> Vercel microVM
└──────────────────────────────────────┘
```

This approach:

- No opencode installation inside the sandbox
- Sandbox lifetime doesn't matter (tools reconnect/recreate)
- AI agent runs code remotely but orchestrates locally
- DB access stays local (no tunnel needed)
- Works with any short-lived sandbox provider

**Decision: support both approaches.** Daytona/SSH use approach A
(full remote opencode). Vercel uses approach B (local opencode +
sandbox tools). The provider abstraction hides this difference.

## How `opencode.ts` changes

### Thread-scoped sandbox resolution

Today `resolveWorkingDirectory` returns a directory path. For sandbox
threads, it also returns sandbox metadata:

```ts
type ResolvedDirectory = {
  projectDirectory: string
  workingDirectory: string
  channelAppId?: string
  // New: sandbox info if thread is on a sandbox
  sandbox?: {
    id: string
    provider: string
    providerSandboxId: string
    baseUrl: string | null
    status: string
  }
}
```

### `initializeOpencodeForDirectory` changes

For Approach A providers (Daytona, SSH): skip local spawn, create SDK
client pointing at `sandbox.baseUrl`:

```ts
if (sandbox && isFullRemoteProvider(sandbox.provider)) {
  const client = createOpencodeClient({ baseUrl: sandbox.baseUrl })
  opencodeServers.set(serverKey, {
    process: null,
    client,
    port: 0,
    type: 'remote',
  })
  return () => client
}
```

For Approach B providers (Vercel): spawn opencode locally as usual,
but inject sandbox tools into the opencode config:

```ts
if (sandbox && isToolBasedProvider(sandbox.provider)) {
  // Normal local spawn, but add sandbox MCP tools
  config.mcp = [
    {
      name: 'sandbox',
      command: 'node',
      args: ['sandbox-mcp-server.js', sandbox.providerSandboxId],
    },
  ]
}
```

## Flows

### Flow 1: User creates new sandbox thread via Discord

```
User: /sandbox provider:vercel repo:github.com/user/app prompt:"fix bug"

1. Bot reads sandbox_providers to get Vercel credentials
2. Calls vercelProvider.create({ repo, envVars })
3. Vercel SDK: Sandbox.create({ source: { type: 'git', url }, ... })
4. Provider returns { sandboxId: 'sbx_abc', baseUrl: '...', status }
5. Bot creates sandboxes DB record (name auto-generated)
6. Bot creates Discord thread "fix bug"
7. Bot creates thread_sandboxes record linking thread -> sandbox
8. For Vercel (Approach B):
   - Spawns local opencode with sandbox MCP tools injected
   - Starts session with user's prompt
9. For Daytona (Approach A):
   - Connects SDK client to sandbox's opencode URL
   - Starts session with user's prompt
10. AI agent works in the sandbox environment
```

### Flow 2: User reuses existing sandbox

```
User: /sandbox sandbox:my-frontend-sandbox prompt:"add dark mode"

1. Bot looks up sandboxes record by name
2. Calls provider.resume(providerSandboxId)
   - Vercel: Sandbox.get() or snapshot-based create
   - Daytona: sandbox.start() if stopped
3. Updates sandbox status and base_url in DB
4. Creates new Discord thread
5. Links thread to existing sandbox
6. Starts session
```

### Flow 3: kimaki send --sandbox

```bash
kimaki send --channel 123 --sandbox my-sandbox --prompt 'run tests'

1. CLI resolves sandbox by name from DB
2. Creates Discord thread
3. Links thread to sandbox
4. Sends prompt to start session
```

### Flow 4: kimaki send --new-sandbox

```bash
kimaki send --channel 123 --new-sandbox \
  --sandbox-provider daytona \
  --prompt 'set up CI pipeline'

1. CLI reads provider config from DB
2. Calls provider.create()
3. Stores sandbox in DB
4. Creates Discord thread
5. Links thread to sandbox
6. Sends prompt
```

### Flow 5: Sandbox lifecycle

```
/sandbox-list
  Shows: name, provider, status, last used, thread count

/sandbox-destroy my-sandbox
  1. Calls provider.destroy(providerSandboxId)
  2. Sets status = "destroyed" in DB
  3. Archives any linked threads still open

Automatic:
  - Health check on session start (is sandbox still running?)
  - Auto-resume stopped sandboxes when thread sends a message
  - Auto-snapshot before sandbox timeout (Vercel)
```

## Provider setup flow

Users must configure provider credentials before using sandboxes.

### `/sandbox-setup` command

```
/sandbox-setup
  provider: vercel | daytona
```

Opens a modal asking for the API key / token. Stores it encrypted
in `sandbox_providers` table.

For Vercel:

- Needs a Vercel access token (from vercel.com/account/tokens)
- And a project ID (for OIDC scoping)

For Daytona:

- Needs an API key (from Daytona Dashboard)
- Optional: API URL if self-hosted

### CLI setup

```bash
kimaki sandbox setup vercel --token vercel_xxx --project-id prj_xxx
kimaki sandbox setup daytona --api-key dtn_xxx
```

## Sandbox MCP tools (Approach B: Vercel)

When a thread is on a Vercel sandbox, kimaki injects an MCP server
that exposes sandbox operations as tools the AI agent can use:

```
Tools:
  sandbox_run_command    — Run a shell command in the sandbox
  sandbox_write_file     — Write a file to the sandbox filesystem
  sandbox_read_file      — Read a file from the sandbox
  sandbox_list_files     — List directory contents
  sandbox_get_url        — Get public URL for a sandbox port
  sandbox_upload_file    — Upload a local file to the sandbox
```

The MCP server manages the Vercel SDK connection internally:

- Reconnects with `Sandbox.get()` if connection drops
- Creates from snapshot if sandbox timed out
- Reports sandbox status in tool error messages

This is transparent to the AI agent — it just uses bash-like tools
that happen to run in the cloud instead of locally.

## What changes from remote-opencode-servers.md

The original plan proposed:

- Channels own sandboxes (`channel_directories.runtime_type`)
- `/add-remote-project` creates a channel
- One sandbox per channel

This plan replaces that with:

- **Threads** attach to sandboxes (via `thread_sandboxes`)
- **Sandboxes** are first-class objects in their own table
- **Multiple threads** can share a sandbox
- **Channels stay local** — they always point to a local directory
- Sandbox selection happens at thread creation time

The sqld + tunnel infrastructure from the original plan is still
needed for Approach A providers (Daytona, SSH) where the remote
opencode process needs DB access. That part is unchanged.

## Implementation phases

### Phase 0: Provider SDK integration (2-3 days)

- Install `@vercel/sandbox` and `@daytonaio/sdk`
- Implement `SandboxProvider` interface for Vercel
- Implement `SandboxProvider` interface for Daytona
- Unit tests for create/resume/stop/destroy lifecycle
- Provider credential storage (sandbox_providers table)

### Phase 1: Database + sandbox management (2 days)

- Add `sandboxes`, `thread_sandboxes`, `sandbox_providers` to schema
- Run `pnpm generate` for Prisma client
- Add migration code in db.ts for existing users
- CRUD functions in database.ts
- `kimaki sandbox list/create/destroy/stop/start` CLI commands

### Phase 2: Thread attachment (2-3 days)

- `/sandbox` slash command with provider/sandbox/repo/prompt options
- Autocomplete for sandbox name field
- Thread creation + sandbox linking
- `resolveWorkingDirectory` returns sandbox metadata
- `kimaki send --sandbox` and `--new-sandbox` flags

### Phase 3: Approach B — Vercel sandbox tools (3-4 days)

- Build sandbox MCP server (sandbox_run_command, etc.)
- Inject MCP config into opencode when thread has Vercel sandbox
- Handle sandbox timeout/reconnect in MCP server
- Snapshot management for session continuity

### Phase 4: Approach A — remote opencode (2-3 days)

- Requires sqld + tunnel from remote-opencode-servers.md Phase 1
- Bootstrap opencode inside Daytona/SSH sandboxes
- Connect SDK client to remote opencode URL
- Env var injection (KIMAKI_DB_URL, KIMAKI_BOT_TOKEN)

### Phase 5: UX polish (2 days)

- `/sandbox-list`, `/sandbox-destroy` commands
- `/sandbox-setup` for provider credential management
- Health check on session start (auto-resume stopped sandboxes)
- Status indicators in Discord
- Auto-snapshot before Vercel timeout

## Total estimated effort

- **Approach B only (Vercel tools):** ~2 weeks
- **Both approaches (Vercel + Daytona):** ~3 weeks
- **Full version with SSH provider:** ~4 weeks
