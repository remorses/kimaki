---
title: Sandbox SDK — TypeScript universal sandbox abstraction
description: |
  Plan for a TypeScript package that wraps multiple sandbox providers
  (Vercel, Daytona, E2B, etc.) behind a single class interface.
  Inspired by cased/sandboxes (Python, 79 stars) but purpose-built
  for kimaki's use case: bootstrapping opencode inside sandboxes and
  exposing a URL for the opencode SDK client to connect to.
prompt: |
  User asked to recreate cased/sandboxes in TypeScript for our use
  case. Read cased/sandboxes source: providers/vercel.py (uses
  vercel Python SDK), providers/daytona.py (uses daytona Python SDK).
  Both are ~200-400 lines wrapping official SDKs behind a unified
  SandboxProvider abstract class. Key insight: getUrl(port) for
  exposing ports is missing from cased/sandboxes but critical for us.
  Also need writeFile by content, snapshot, extendTimeout. Context:
  plans/sandbox-threads.md (thread-scoped sandbox design),
  plans/remote-opencode-servers.md (original remote plan).
  Studied @vercel/sandbox and @daytonaio/sdk npm packages.
  Reference repos: vercel-labs/coding-agent-template,
  daytonaio/daytona/guides/typescript/opencode/opencode-sdk.
---

# Sandbox SDK

TypeScript package providing a universal interface to cloud sandbox
providers. Each provider wraps the official SDK (same pattern as
cased/sandboxes). A `SandboxHandle` class gives uniform access to
a running sandbox: run commands, expose ports, read/write files.

## Reference

- **cased/sandboxes** (Python, MIT, 79 stars):
  https://github.com/cased/sandboxes
  Universal sandbox library for Python. Supports E2B, Modal, Daytona,
  Hopx, Vercel, Sprites (Fly.io), Cloudflare. Each provider is
  ~200-400 lines wrapping the official SDK. Our TypeScript version
  follows the same pattern but adds getUrl(port), extendTimeout,
  snapshot, and uploadFile which cased/sandboxes lacks.

## Two-phase architecture

After bootstrap, kimaki does NOT use the sandbox handle for runtime
operations. The opencode SDK (`@opencode-ai/sdk/v2`) handles
everything once `opencode serve` is running:

```
Phase 1: BOOTSTRAP (uses SandboxHandle)
  create sandbox → uploadFile(tarball) → runCommand(install) →
  runCommand(opencode serve) → getUrl(port) → return URL

Phase 2: SESSION (uses opencode SDK, not SandboxHandle)
  client = createOpencodeClient({ baseUrl: url })
  client.session.shell({ command: 'git checkout ...' })
  client.session.prompt({ parts: [...] })
  client.file.read({ path: '...' })
  client.pty.create({ command: 'npm test' })
  client.vcs.get()
  client.file.status()
```

The SandboxHandle is only kept alive for lifecycle operations:
extendTimeout (heartbeat), snapshot (on session end), stop, destroy.
All git operations (checkout, commit, push, branch) happen through
`client.session.shell()` or through the AI agent's built-in tools.

## Package location

`cli/src/sandbox/` — not a separate npm package, lives inside
the kimaki cli package. Can be extracted later if needed.

```
cli/src/sandbox/
  index.ts                  — re-exports
  types.ts                  — shared types, SandboxStatus, etc.
  sandbox-handle.ts         — SandboxHandle abstract class
  sandbox-provider.ts       — SandboxProvider abstract class
  bootstrap.ts              — bootstrapOpencode() shared function
  auto-detect.ts            — auto-detect provider from env vars
  providers/
    vercel.ts               — wraps @vercel/sandbox
    daytona.ts              — wraps @daytonaio/sdk
```

## Class design

### `SandboxHandle` — a running sandbox you can interact with

Returned by `provider.create()` and `provider.get()`. Carries the
provider SDK instance internally. All methods are async.

```ts
type SandboxStatus = 'creating' | 'running' | 'stopped' | 'failed' | 'destroyed'

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

abstract class SandboxHandle {
  /** Provider-assigned unique ID (e.g. 'sbx_abc123') */
  abstract readonly sandboxId: string

  /** Current status */
  abstract status(): Promise<SandboxStatus>

  // ── Command execution ─────────────────────────────

  /** Run a command. Blocks until exit unless detached: true.
   *  detached commands run in background (for servers). */
  abstract runCommand(opts: {
    cmd: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    detached?: boolean
  }): Promise<CommandResult>

  // ── Port exposure ─────────────────────────────────

  /** Get public HTTPS URL for a port running inside the sandbox.
   *  Vercel: sandbox.domain(port)
   *  Daytona: sandbox.getPreviewLink(port).url */
  abstract getUrl(port: number): Promise<string>

  // ── Filesystem ────────────────────────────────────

  /** Write content to a file inside the sandbox */
  abstract writeFile(
    remotePath: string,
    content: Buffer | string,
  ): Promise<void>

  /** Read a file from the sandbox */
  abstract readFile(remotePath: string): Promise<Buffer>

  /** Upload a local file to the sandbox (for large files like
   *  tarballs where you don't want to load into memory) */
  abstract uploadFile(localPath: string, remotePath: string): Promise<void>

  // ── Lifecycle ─────────────────────────────────────

  /** Stop the sandbox (preserves state for resume) */
  abstract stop(): Promise<void>

  /** Extend timeout before auto-shutdown.
   *  Vercel: sandbox.extendTimeout(ms)
   *  Daytona: no-op (no timeout by default) */
  abstract extendTimeout(ms: number): Promise<void>

  /** Save sandbox state as a snapshot for fast resume.
   *  Returns provider-native snapshot ID. */
  abstract snapshot(): Promise<{ snapshotId: string }>

  /** Permanently destroy this sandbox */
  abstract destroy(): Promise<void>
}
```

### `SandboxProvider` — manages sandbox lifecycle

One instance per provider. Configured with API credentials. Creates
and retrieves `SandboxHandle` instances.

```ts
type CreateSandboxOpts = {
  /** Git repo to clone (for source: git providers) */
  repo?: string
  /** GitHub PAT for private repos */
  gitToken?: string
  /** Create from a saved snapshot instead of fresh */
  snapshotId?: string
  /** Runtime environment (e.g. 'node24', 'python3.13') */
  runtime?: string
  /** Ports to expose (always includes opencode port) */
  ports?: number[]
  /** VM resources */
  resources?: {
    vcpus?: number
    memoryMb?: number
  }
  /** Sandbox max lifetime in ms (Vercel: 45min-5hr) */
  timeout?: number
  /** Environment variables injected into the sandbox */
  envVars?: Record<string, string>
  /** Human-readable label */
  label?: string
}

type SandboxInfo = {
  sandboxId: string
  status: SandboxStatus
  createdAt?: Date
  label?: string
}

abstract class SandboxProvider {
  abstract readonly name: string

  /** Create a new sandbox, return a handle to it */
  abstract create(opts: CreateSandboxOpts): Promise<SandboxHandle>

  /** Reconnect to an existing sandbox by provider ID.
   *  Starts it if stopped (Daytona) or creates from snapshot
   *  if timed out (Vercel). */
  abstract get(sandboxId: string): Promise<SandboxHandle>

  /** List all sandboxes managed by this provider */
  abstract list(): Promise<SandboxInfo[]>

  /** Check if provider credentials are valid */
  abstract healthCheck(): Promise<boolean>
}
```

### `bootstrapOpencode()` — shared across all providers

Installs opencode inside a sandbox and starts `opencode serve`.
Uses only `SandboxHandle` methods — provider-agnostic.

```ts
const OPENCODE_PORT = 7777

type BootstrapOpts = {
  /** Env vars for the opencode process (KIMAKI_DB_URL, etc.) */
  envVars: Record<string, string>
  /** Pin opencode version, default 'latest' */
  opencodeVersion?: string
  /** Port to serve on, default 7777 */
  port?: number
  /** Working directory for opencode serve */
  cwd?: string
}

type BootstrapResult = {
  /** Public URL where the opencode API is reachable */
  url: string
  /** The port opencode is serving on */
  port: number
}

async function bootstrapOpencode(
  handle: SandboxHandle,
  opts: BootstrapOpts,
): Promise<BootstrapResult> {
  const port = opts.port || OPENCODE_PORT

  // 1. Check if opencode is already installed (snapshot resume)
  const check = await handle.runCommand({
    cmd: 'which',
    args: ['opencode'],
  })

  if (check.exitCode !== 0) {
    // 2. Install opencode
    const version = opts.opencodeVersion || 'latest'
    const install = await handle.runCommand({
      cmd: 'npm',
      args: ['install', '-g', `opencode-ai@${version}`],
    })
    if (install.exitCode !== 0) {
      throw new Error(`Failed to install opencode: ${install.stderr}`)
    }
  }

  // 3. Write env vars to a file
  const envContent = Object.entries(opts.envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  await handle.writeFile('/tmp/kimaki-env', envContent)

  // 4. Start opencode serve (detached)
  await handle.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      [
        'set -a',
        'source /tmp/kimaki-env',
        'set +a',
        `opencode serve --port ${port} --hostname 0.0.0.0`,
      ].join(' && '),
    ],
    detached: true,
    cwd: opts.cwd,
  })

  // 5. Get public URL
  const url = await handle.getUrl(port)

  // 6. Wait for health endpoint (poll with backoff)
  await waitForHealth(`${url}/api/health`, {
    maxAttempts: 30,
    intervalMs: 1000,
  })

  return { url, port }
}
```

### `uploadProject()` — send local project to sandbox

Tars the local project (tracked files + .git) and extracts inside
the sandbox.

```ts
type UploadProjectOpts = {
  /** Local project directory */
  projectDir: string
  /** Where to extract inside the sandbox */
  remotePath?: string // default: '/workspace'
}

async function uploadProject(
  handle: SandboxHandle,
  opts: UploadProjectOpts,
): Promise<void> {
  const remotePath = opts.remotePath || '/workspace'
  const tmpDir = path.join(
    opts.projectDir,
    'tmp',
    `sandbox-upload-${Date.now()}`,
  )
  const tarPath = `${tmpDir}.tar.gz`

  try {
    // 1. Shallow clone locally (tracked files + .git, no gitignored)
    await execAsync(`git clone --depth 1 file://${opts.projectDir} ${tmpDir}`)

    // 2. Create tarball
    await execAsync(`tar czf ${tarPath} -C ${tmpDir} .`)

    // 3. Upload to sandbox
    await handle.uploadFile(tarPath, '/tmp/project.tar.gz')

    // 4. Extract inside sandbox
    await handle.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `mkdir -p ${remotePath} && tar xzf /tmp/project.tar.gz -C ${remotePath} && rm /tmp/project.tar.gz`,
      ],
    })
  } finally {
    // 5. Cleanup local temp files
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(tarPath, { force: true })
  }
}
```

### Auto-detect provider

```ts
function autoDetectProvider(): SandboxProvider | null {
  // Check env vars in priority order
  if (process.env.DAYTONA_API_KEY) {
    return new DaytonaProvider({
      apiKey: process.env.DAYTONA_API_KEY,
    })
  }
  if (
    process.env.VERCEL_TOKEN &&
    process.env.VERCEL_PROJECT_ID &&
    process.env.VERCEL_TEAM_ID
  ) {
    return new VercelProvider({
      token: process.env.VERCEL_TOKEN,
      projectId: process.env.VERCEL_PROJECT_ID,
      teamId: process.env.VERCEL_TEAM_ID,
    })
  }
  return null
}
```

## Provider implementations

### `VercelProvider` (~200 lines)

Wraps `@vercel/sandbox` npm package.

```ts
import { Sandbox } from '@vercel/sandbox'

class VercelProvider extends SandboxProvider {
  readonly name = 'vercel'

  constructor(
    private config: {
      token: string
      projectId: string
      teamId: string
    },
  ) {
    super()
  }

  async create(opts) {
    const sandbox = await Sandbox.create({
      token: this.config.token,
      projectId: this.config.projectId,
      teamId: this.config.teamId,
      source: opts.repo
        ? {
            type: 'git',
            url: opts.repo,
            ...(opts.gitToken
              ? { username: 'x-access-token', password: opts.gitToken }
              : {}),
          }
        : undefined,
      ...(opts.snapshotId
        ? { source: { type: 'snapshot', snapshotId: opts.snapshotId } }
        : {}),
      ports: opts.ports || [7777],
      runtime: opts.runtime || 'node24',
      timeout: opts.timeout || 5 * 60 * 1000,
      resources: opts.resources?.vcpus
        ? { vcpus: opts.resources.vcpus }
        : undefined,
    })
    return new VercelSandboxHandle(sandbox)
  }

  async get(sandboxId) {
    const sandbox = await Sandbox.get({
      sandboxId,
      token: this.config.token,
      projectId: this.config.projectId,
      teamId: this.config.teamId,
    })
    return new VercelSandboxHandle(sandbox)
  }

  // list(), healthCheck() ...
}

class VercelSandboxHandle extends SandboxHandle {
  constructor(private sandbox: Sandbox) {
    super()
  }

  get sandboxId() {
    return this.sandbox.sandboxId
  }

  async runCommand(opts) {
    if (opts.detached) {
      await this.sandbox.runCommand({
        cmd: opts.cmd,
        args: opts.args,
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
      })
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const result = await this.sandbox.runCommand({
      cmd: opts.cmd,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
    })
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  async getUrl(port) {
    return this.sandbox.domain(port)
  }

  async writeFile(remotePath, content) {
    const buf = typeof content === 'string' ? Buffer.from(content) : content
    await this.sandbox.writeFiles([{ path: remotePath, content: buf }])
  }

  async readFile(remotePath) {
    return await this.sandbox.readFile(remotePath)
  }

  async uploadFile(localPath, remotePath) {
    const content = await fs.readFile(localPath)
    await this.writeFile(remotePath, content)
  }

  async stop() {
    await this.sandbox.stop()
  }

  async extendTimeout(ms) {
    await this.sandbox.extendTimeout(ms)
  }

  async snapshot() {
    const result = await this.sandbox.snapshot()
    return { snapshotId: result.snapshotId }
  }

  async destroy() {
    await this.sandbox.stop()
  }
}
```

### `DaytonaProvider` (~200 lines)

Wraps `@daytonaio/sdk` npm package.

```ts
import { Daytona } from '@daytonaio/sdk'

class DaytonaProvider extends SandboxProvider {
  readonly name = 'daytona'
  private client: Daytona

  constructor(private config: { apiKey: string }) {
    super()
    this.client = new Daytona({ apiKey: config.apiKey })
  }

  async create(opts) {
    const sandbox = await this.client.create({
      language: 'typescript',
      envVars: opts.envVars || {},
      resources: opts.resources
        ? {
            cpu: opts.resources.vcpus,
            memory: opts.resources.memoryMb
              ? Math.ceil(opts.resources.memoryMb / 1024)
              : undefined,
          }
        : undefined,
      public: true,
      autoStopInterval: 0,
    })
    return new DaytonaSandboxHandle(sandbox, this.client)
  }

  async get(sandboxId) {
    const sandbox = await this.client.get(sandboxId)
    // Resume if stopped
    if (sandbox.instance?.state === 'stopped') {
      await sandbox.start()
    }
    return new DaytonaSandboxHandle(sandbox, this.client)
  }

  // list(), healthCheck() ...
}

class DaytonaSandboxHandle extends SandboxHandle {
  constructor(
    private sandbox: DaytonaSandbox,
    private client: Daytona,
  ) {
    super()
  }

  get sandboxId() {
    return this.sandbox.id
  }

  async runCommand(opts) {
    const cmd = opts.args ? `${opts.cmd} ${opts.args.join(' ')}` : opts.cmd

    if (opts.detached) {
      const sessionId = `detached-${Date.now()}`
      await this.sandbox.process.executeSessionCommand(sessionId, {
        command: opts.cwd ? `cd ${opts.cwd} && ${cmd}` : cmd,
        runAsync: true,
      })
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await this.sandbox.process.executeCommand(cmd, {
      cwd: opts.cwd,
    })
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.result || '',
      stderr: '',
    }
  }

  async getUrl(port) {
    const preview = await this.sandbox.getPreviewLink(port)
    return preview.url
  }

  async writeFile(remotePath, content) {
    const buf = typeof content === 'string' ? Buffer.from(content) : content
    await this.sandbox.fs.uploadFile(buf, remotePath)
  }

  async readFile(remotePath) {
    return await this.sandbox.fs.downloadFile(remotePath)
  }

  async uploadFile(localPath, remotePath) {
    const content = await fs.readFile(localPath)
    await this.writeFile(remotePath, content)
  }

  async stop() {
    await this.client.stop(this.sandbox)
  }

  async extendTimeout(_ms) {
    // No-op — Daytona has no timeout with autoStopInterval: 0
  }

  async snapshot() {
    // Daytona uses image-based snapshots
    // TODO: implement when needed
    throw new Error('Snapshots not yet implemented for Daytona')
  }

  async destroy() {
    await this.client.remove(this.sandbox)
  }
}
```

## How kimaki uses this

### Full flow: user runs `/sandbox`

```ts
// 1. Resolve provider (from DB or auto-detect)
const provider = await getProviderForChannel(channelId)

// 2. Create sandbox
const handle = await provider.create({
  ports: [7777],
  runtime: 'node24',
  envVars: {
    KIMAKI_DB_URL: `http://${hranaHost}:${hranaPort}`,
    KIMAKI_BOT_TOKEN: botToken,
    KIMAKI_LOCK_PORT: String(lockPort),
  },
})

// 3. Upload project files
await uploadProject(handle, { projectDir })

// 4. Bootstrap opencode
const { url } = await bootstrapOpencode(handle, {
  envVars: {
    /* same as above */
  },
  cwd: '/workspace',
})

// 5. Store in DB
await prisma.sandboxes.create({
  data: {
    name: sandboxName,
    provider: provider.name,
    provider_sandbox_id: handle.sandboxId,
    status: 'running',
    base_url: url,
    channel_id: channelId,
  },
})

// 6. Connect with opencode SDK (existing code, unchanged)
const client = createOpencodeClient({ baseUrl: url })
```

### Heartbeat for Vercel sandboxes

```ts
// During active session, extend timeout periodically
const heartbeat = setInterval(
  async () => {
    if (provider.name === 'vercel') {
      await handle.extendTimeout(5 * 60 * 1000) // +5 min
    }
  },
  3 * 60 * 1000,
) // every 3 min

// On session end
clearInterval(heartbeat)
const { snapshotId } = await handle.snapshot()
await prisma.sandboxes.update({
  where: { id: sandboxDbId },
  data: { status: 'stopped', snapshot_id: snapshotId },
})
```

## Estimated effort per file

| File                 | Lines    | Notes                                    |
| -------------------- | -------- | ---------------------------------------- |
| types.ts             | ~40      | SandboxStatus, CommandResult, opts types |
| sandbox-handle.ts    | ~60      | Abstract class with method signatures    |
| sandbox-provider.ts  | ~30      | Abstract class with method signatures    |
| providers/vercel.ts  | ~200     | Wraps @vercel/sandbox                    |
| providers/daytona.ts | ~200     | Wraps @daytonaio/sdk                     |
| bootstrap.ts         | ~80      | bootstrapOpencode + waitForHealth        |
| auto-detect.ts       | ~30      | Env var detection                        |
| index.ts             | ~10      | Re-exports                               |
| **Total**            | **~650** |                                          |

Plus integration into kimaki:

| File                | Changes                                                   |
| ------------------- | --------------------------------------------------------- |
| schema.prisma       | Add sandboxes, thread_sandboxes, sandbox_providers tables |
| database.ts         | CRUD functions for sandbox tables                         |
| opencode.ts         | Sandbox-aware initializeOpencodeForDirectory              |
| discord-utils.ts    | resolveWorkingDirectory returns sandbox info              |
| commands/sandbox.ts | /sandbox, /sandbox-list, /sandbox-destroy                 |
| cli.ts              | kimaki sandbox subcommand, --sandbox/--new-sandbox flags  |

## Implementation order

1. **types.ts + sandbox-handle.ts + sandbox-provider.ts** — interfaces
2. **providers/daytona.ts** — Daytona first (simpler, no timeout dance)
3. **bootstrap.ts** — bootstrapOpencode + uploadProject
4. **providers/vercel.ts** — Vercel second (needs extendTimeout/snapshot)
5. **auto-detect.ts + index.ts** — wiring
6. **Integration** — schema, commands, CLI flags

## Dependencies to add

```bash
cd cli && pnpm install @vercel/sandbox @daytonaio/sdk
```

Both are optional peer dependencies — only loaded when the provider
is actually used (dynamic import with try/catch, same pattern as
cased/sandboxes).
