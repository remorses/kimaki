---
title: Debugging and profiling kimaki
description: >
  Recipes for debugging the kimaki bot: the log file, OpenCode session event
  JSONL (env vars, sqlite export, buffer shape, jq queries), heap
  snapshots, live CPU profiling, CPU profiling tests, and the
  ~/.kimaki/bin/kimaki command shim. Read when debugging session state, event
  ordering, memory, CPU, slow tests, or agents failing to run `kimaki` commands.
---

# Debugging and profiling kimaki

| Symptom                                        | Start with                                  |
| ---------------------------------------------- | ------------------------------------------- |
| bot error, session not responding              | `<dataDir>/kimaki.log`                      |
| wrong footer, stuck typing, ordering bug       | session event JSONL + jq                    |
| memory growth                                  | heap snapshot (`kill -SIGUSR1 <PID>`)       |
| high CPU in the running bot                    | `cpuprof` in the bot terminal               |
| slow test file                                 | `VITEST_CPU_PROF=1`                         |
| agent cannot run `kimaki send` from bash       | command shim in `~/.kimaki/bin`             |

## logs

kimaki writes logs to `<dataDir>/kimaki.log` (default `~/.kimaki/kimaki.log`). Every bot start begins a fresh file and moves the previous run to `kimaki.previous.log`, so a crash and its restart keep the crash reason. Crashes (`uncaughtException`, unhandled rejections) are logged before Node exits. File logging works in all environments (dev and production), also under vitest when terminal logs are suppressed.

Lines are `<ISO time> <LEVEL> [<MODULE>] <message>`. Errors are logged with their cause chain, error-level lines also get the root cause stack. The file is written with one fd and `writeSync`: lines stay ordered and reach disk before a crash.

```bash
grep -E ' (WARN|ERROR) ' ~/.kimaki/kimaki.log | tail -n 50
grep 'run (started|finished|failed)' -E ~/.kimaki/kimaki.log
```

### OpenCode service log

The shared OpenCode 2 daemon (`opencode2 serve --service`) appends logfmt lines to `$XDG_DATA_HOME/opencode/log/opencode.log` (default `~/.local/share/opencode/log/opencode.log`, `opencode2 debug paths` prints it). It is never truncated or rotated. `run=<8 chars>` identifies one daemon process. `--log-level DEBUG` or `OPENCODE_LOG_LEVEL=DEBUG` raises the level, `--print-logs` also prints to stderr. Pid and URL of the daemon are in `~/.local/state/opencode/service.json`.

```bash
LOG=~/.local/share/opencode/log/opencode.log
RUN=$(tail -n 1 $LOG | grep -o 'run=[a-z0-9]*')
grep "$RUN " $LOG | grep -E '^timestamp=[^ ]+ level=(ERROR|WARN)' | tail -n 50
```

Source: `packages/core/src/observability/logging.ts` and `packages/core/src/global.ts` in anomalyco/opencode (`dev` branch).

## session event JSONL

To debug OpenCode event ordering, set `KIMAKI_LOG_OPENCODE_SESSION_EVENTS=1`. This writes JSONL files under `<dataDir>/opencode-session-events/` (one file per session id, like `ses_xxx.jsonl`). Use `KIMAKI_OPENCODE_SESSION_EVENTS_DIR` to override the output directory.

Example when running a test to debug events:

```bash
KIMAKI_OPENCODE_SESSION_EVENTS_DIR=./tmp/kimaki-test-3423 KIMAKI_LOG_OPENCODE_SESSION_EVENTS=1 pnpm run test --run src/test-file.test.ts -t test-name
```

For live user-session debugging (without restarting with env vars), export the persisted session event buffer from sqlite:

```bash
kimaki session export-events-jsonl --session <session_id> --out ./tmp/session-events.jsonl
```

Use this for session-state regressions (for example a footer appearing after abort). Use the exported native events as fixture input for `event-stream-state.test.ts` or `discord-event-projection.test.ts` coverage of the pure derivation helpers.

### buffer and JSONL shape

`ThreadSessionRuntime` keeps the last 1000 OpenCode events in memory per thread (`eventBuffer`) for event-sourcing derivation and waiters. Long string values are truncated before storage to avoid memory spikes, but the native OpenCode v2 event shape is preserved.

Each JSONL line is one raw OpenCode event. Do not wrap events with Kimaki metadata.

### jq recipes

```bash
# list event type counts for one session file
jq -r '.type' ~/.kimaki/opencode-session-events/ses_xxx.jsonl | sort | uniq -c

# show execution lifecycle events
jq -r 'select(.type | startswith("session.execution.")) | [.created, .type, .data.sessionID, .data.executionID] | @tsv' ~/.kimaki/opencode-session-events/ses_xxx.jsonl

# filter by a specific event type
jq -r 'select(.type=="session.tool.called")' ~/.kimaki/opencode-session-events/ses_xxx.jsonl

# show timestamps + event types
jq -r '[.created, .type] | @tsv' ~/.kimaki/opencode-session-events/ses_xxx.jsonl
```

## heap snapshots and memory debugging

kimaki has a built-in heap monitor (`cli/src/heap-monitor.ts`) that runs every 30s and checks V8 heap usage. At **85% heap used** it writes a `.heapsnapshot` file to `~/.kimaki/heap-snapshots/`. There is a 5 minute cooldown between automatic snapshots to avoid disk spam.

To trigger a heap snapshot manually at any time:

```bash
kill -SIGUSR1 <PID>
```

Snapshots are saved as `heap-<date>-<sizeMB>MB.heapsnapshot` in `~/.kimaki/heap-snapshots/`. Open them in Chrome DevTools (Memory tab > Load) to inspect what is holding memory.

Signal summary:

- `SIGUSR1`: write heap snapshot to disk
- `SIGUSR2`: graceful restart (only when the user asks)

## live CPU profiling

To capture a CPU profile from a **running** kimaki bot without restarting, type this in the same terminal and press Enter:

```
cpuprof
```

Type `cpuprof` again to stop, or wait **20 seconds** for auto-stop. The profile is written to `<dataDir>/cpu-profiles/cpu-<date>.cpuprofile` (default `~/.kimaki/cpu-profiles/`). Open it in Chrome DevTools (Performance tab > Load) or:

```bash
bunx profano ~/.kimaki/cpu-profiles/cpu-*.cpuprofile
```

This uses `node:inspector` `Profiler.start` / `Profiler.stop` inside the bot process (`cli/src/cpu-profiler.ts`). It does not use SIGUSR1 (that stays heap snapshots). stdin must be a TTY; piped stdin is ignored.

## CPU profiling tests

Set `VITEST_CPU_PROF=1` to generate `.cpuprofile` files when running vitest. Profiles land in `cli/tmp/cpu-profiles/`. Always run a single test file to avoid hanging the machine; the config forces `maxForks: 1` when profiling.

```bash
cd cli
VITEST_CPU_PROF=1 pnpm run test --run src/some-file.e2e.test.ts

# top-down self-time report in the terminal
bunx profano tmp/cpu-profiles/CPU.*.cpuprofile

# interactive flame chart in the browser
npx cpupro tmp/cpu-profiles/CPU.*.cpuprofile
```

## kimaki command shim (`~/.kimaki/bin/kimaki`)

`ensureKimakiCommandShim()` in `cli/src/opencode-command.ts` generates a shell script at `~/.kimaki/bin/kimaki` (or `kimaki.cmd` on Windows) every time the bot starts. It captures `process.execPath`, `process.execArgv`, and `process.argv[1]` into an `exec` one-liner, so the shim always mirrors the current process.

The shim directory is prepended to `PATH` in the env passed to the OpenCode server process (`cli/src/opencode.ts`). This lets agent sessions run `kimaki send`, `kimaki upload-to-discord`, `kimaki tunnel`, etc. as regular shell commands via the bash tool, however kimaki was installed (npx, global install, local dev).

In local dev the shim contains tsx loader flags (`--require` / `--import`) because the bot was launched with tsx against the raw `.ts` entry point. In production (npm package) there are no tsx flags and the entry script is the compiled `bin.js`. The shim reflects how the current process was started; there is no special-casing.
