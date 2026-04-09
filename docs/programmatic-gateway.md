<!--
title: Starting Kimaki Programmatically (Gateway Mode)
description: |
  How to spawn kimaki as a child process in gateway mode, parse structured
  SSE events from stdout, and integrate it into a cloud hosting platform
  that provisions kimaki instances for end users.
prompt: |
  Create a doc explaining how to start kimaki programmatically in --gateway
  mode for the use case of offering kimaki as a cloud service. Cover the
  SSE event protocol, eventsource-parser usage, the full event lifecycle,
   and custom callback URLs. Reference cli/src/cli.ts ProgrammaticEvent
   type and cli/scripts/test-gateway-programmatic.ts for the working
  example.
-->

# Starting Kimaki Programmatically (Gateway Mode)

When kimaki runs in a non-TTY environment (piped stdout, no terminal), it emits
structured events on stdout using the SSE (Server-Sent Events) wire format.
This lets a host process parse lifecycle events reliably even when other log
lines, warnings, and debug output are interleaved on the same stream.

## Use case

You are building a cloud platform that provisions kimaki instances for users.
Each user gets their own kimaki process running on a VPS. Your platform needs to:

1. Start kimaki for a new user
2. Get the Discord install URL to show in your web UI
3. Know when the user has authorized the bot
4. Know when the bot is fully ready and listening for messages
5. Redirect the user to your own page after OAuth (custom callback URL)

## Event lifecycle

When kimaki starts in gateway mode with piped stdout, it emits these events
in order:

```
install_url  →  authorized  →  ready
                    ↑
                    │ (user clicks URL and authorizes)
```

| Event | Payload | Description |
|---|---|---|
| `install_url` | `{ type, url }` | Discord OAuth URL to send to the user |
| `authorized` | `{ type, guild_id }` | User authorized the bot in a guild |
| `ready` | `{ type, app_id, guild_ids }` | Bot is connected and listening |
| `error` | `{ type, message, install_url? }` | Something went wrong |

These are defined as the `ProgrammaticEvent` union type in `cli/src/cli.ts`.

## SSE wire format

Each event is a single line prefixed with `data: ` and terminated with `\n\n`:

```
data: {"type":"install_url","url":"https://kimaki.dev/discord-install?clientId=...&callbackUrl=..."}\n\n
```

This is standard SSE format. The `data:` prefix is what makes it robust — log
lines, warnings, spinner output, and other noise do not start with `data:` at
column 0, so the parser ignores them completely.

## Parsing events with eventsource-parser

Install the parser:

```bash
npm install eventsource-parser
```

Parse events from the child process stdout:

```typescript
import { spawn } from 'node:child_process'
import { createParser } from 'eventsource-parser'

const child = spawn('kimaki', [
  '--gateway',
  '--restart-onboarding',
  '--data-dir', '/data/user-abc',
  '--gateway-callback-url', 'https://your-platform.com/oauth-done',
], {
  env: {
    ...process.env,
    // Unique port per instance to avoid conflicts between concurrent kimaki processes
    KIMAKI_LOCK_PORT: '31200',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const parser = createParser({
  onEvent(sseEvent) {
    const event = JSON.parse(sseEvent.data)

    switch (event.type) {
      case 'install_url': {
        // Send this URL to your user (email, web UI, etc.)
        console.log('Install URL:', event.url)
        break
      }
      case 'authorized': {
        // User authorized the bot — you now have their guild_id
        console.log('Guild ID:', event.guild_id)
        break
      }
      case 'ready': {
        // Bot is fully connected and listening for Discord messages
        console.log('App ID:', event.app_id)
        console.log('Guild IDs:', event.guild_ids)
        break
      }
      case 'error': {
        console.error('Error:', event.message)
        break
      }
    }
  },
})

// Feed raw stdout into the parser — it extracts data: lines, ignores everything else
child.stdout.on('data', (chunk) => {
  parser.feed(chunk.toString())
})
```

## CLI flags

| Flag | Required | Description |
|---|---|---|
| `--gateway` | yes | Use the shared Kimaki gateway bot |
| `--restart-onboarding` | for fresh setup | Force the onboarding flow even if saved credentials exist |
| `--data-dir <path>` | recommended | Isolated data directory per user instance |
| `--gateway-callback-url <url>` | optional | Redirect user here after OAuth instead of default kimaki page |

## Custom callback URL

Pass `--gateway-callback-url` to redirect the user to your own page after they
authorize the bot. The callback URL receives a `?guild_id=<id>` query parameter
so your platform knows which guild was authorized.

```bash
kimaki --gateway --gateway-callback-url https://your-platform.com/setup-done
```

The install URL emitted in the `install_url` event will include the callback:

```
https://kimaki.dev/discord-install?clientId=...&callbackUrl=https%3A%2F%2Fyour-platform.com%2Fsetup-done
```

After the user authorizes, Discord redirects to kimaki's OAuth handler, which
then redirects to your callback URL with `?guild_id=<id>` appended.

## Running multiple instances

Each kimaki process needs a unique `KIMAKI_LOCK_PORT` to avoid conflicts.
Without it, a new process will kill the existing one.

```typescript
const lockPort = 31100 + userIndex

const child = spawn('kimaki', ['--gateway', '--data-dir', userDataDir], {
  env: { ...process.env, KIMAKI_LOCK_PORT: String(lockPort) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
```

Also use a unique `--data-dir` per user so their SQLite databases, logs, and
credentials are isolated.

## Why SSE format instead of plain JSON lines

Process stdout is noisy. Kimaki logs, clack prompts, OpenCode server output,
and debug messages all go to stdout. Parsing JSON by checking if a line starts
with `{` is fragile — a log line could start with `{` by coincidence.

SSE format solves this because:
- Only lines starting with exactly `data:` at column 0 are parsed as events
- Other SSE fields (`id:`, `event:`, `retry:`) are ignored by the parser if
  you only read `.data`
- Log lines, warnings, and spinners are silently discarded
- The parser handles chunks split across multiple `data` events correctly

## Working example

See `cli/scripts/test-gateway-programmatic.ts` for a complete working
script with colored terminal output that demonstrates the full flow.

```bash
cd cli
npx tsx scripts/test-gateway-programmatic.ts
```
