---
name: tuistory
description: |
  Playwright for terminal apps. Like tmux but designed for agents — virtual terminals you can
  type into, press keys, wait for text, take snapshots, and screenshot as images.

  tuistory has **2 modes**:

  - **CLI** (`tuistory` command) — shell-based. Launch sessions, type, press keys, snapshot, screenshot.
    Runs a background daemon that persists sessions across commands. Install globally or use `npx`/`bunx`.
    **You MUST run `tuistory --help` before using the CLI** to see the latest commands and options.
  - **JS/TS API** (`import { launchTerminal } from 'tuistory'`) — programmatic. Use in vitest/bun:test
    to write Playwright-style tests for CLIs and TUIs with inline snapshots.

  Use tuistory when you need to:
  - Write e2e tests for CLI/TUI apps (vitest, bun:test) with inline snapshots
  - Automate terminal interactions (launch a REPL, debugger, or TUI and drive it)
  - Screenshot terminal as images to send to users (Discord bots, agent UIs like kimaki/openclaw)
  - Reproduce bugs in interactive CLIs by scripting the exact steps
  - Explore TUI apps progressively with observe-act-observe loops
---

# tuistory

Playwright for terminal user interfaces. Write end-to-end tests for CLI and TUI applications.

tuistory has **2 modes**:

1. **CLI** — the `tuistory` shell command. Launch terminal sessions, type text, press keys, take text snapshots or image screenshots. Sessions run in a background daemon and persist across commands.
2. **JS/TS API** — `import { launchTerminal } from 'tuistory'`. Use programmatically in test files (vitest, bun:test) to write Playwright-style tests with inline snapshots.

## CLI usage

**REQUIREMENT:** You MUST run `tuistory --help` before using the CLI. The CLI evolves and the help output is the source of truth for available commands, options, and syntax. Always check it first.

Install globally or use npx/bunx:

```bash
# global
bun add -g tuistory
npm install -g tuistory

# or without installing
npx tuistory --help
bunx tuistory --help
```

### CLI quick reference

```bash
tuistory launch <command> -s <name> [--cols N] [--rows N] [--env KEY=VAL]
tuistory -s <name> snapshot --trim
tuistory -s <name> screenshot -o image.jpg --pixel-ratio 2
tuistory -s <name> type "text"
tuistory -s <name> press enter
tuistory -s <name> press ctrl c
tuistory -s <name> click "Submit"
tuistory -s <name> wait "pattern" --timeout 10000
tuistory -s <name> wait "/regex/" --timeout 10000
tuistory -s <name> scroll down 5
tuistory -s <name> resize 120 40
tuistory -s <name> close
tuistory sessions
tuistory daemon-stop
```

Always run `snapshot --trim` after every action to see the current terminal state.

### Screenshot for agent bots

Capture terminal as an image to upload to users (Discord, Slack, web UIs).
Use `--pixel-ratio 2` for sharp images on social media and messaging apps:

```bash
tuistory -s myapp screenshot -o /tmp/terminal.jpg --pixel-ratio 2
# then upload /tmp/terminal.jpg to the user
```

## JS/TS API (library)

```bash
bun add tuistory    # or npm install tuistory
```

```ts
import { launchTerminal } from 'tuistory'

const session = await launchTerminal({
  command: 'my-cli',
  args: ['--flag'],
  cols: 120,
  rows: 36,
  cwd: '/path/to/dir',
  env: { MY_VAR: 'value' },
})

// observe
const text = await session.text()               // full terminal text
const text = await session.text({ trimEnd: true }) // trimmed
const bold = await session.text({ only: { bold: true } }) // style filter

// act
await session.type('hello world')               // type character by character
await session.press('enter')                    // single key
await session.press(['ctrl', 'c'])              // key chord
await session.click('Submit')                   // click on text

// wait
await session.waitForText('Ready', { timeout: 10000 })
await session.waitForText(/Loading\.\.\./, { timeout: 5000 })

// screenshot to image
const data = session.getTerminalData()
const { renderTerminalToImage } = await import('ghostty-opentui/image')
const image = await renderTerminalToImage(data, { format: 'jpeg', devicePixelRatio: 2 })

// cleanup
session.close()
```

## Writing tests with vitest

tuistory is like Playwright but for CLIs. The workflow is: **observe** (snapshot with inline snapshot), **act** (type/press/click), **observe** again. Build tests progressively.

### Step 1: Launch and observe

Start with an empty inline snapshot. Run with `--update` / `-u` to fill it in.

```ts
import { test, expect } from 'vitest'
import { launchTerminal } from 'tuistory'

test('my CLI shows help', async () => {
  const session = await launchTerminal({
    command: 'my-cli',
    args: ['--help'],
    cols: 120,
    rows: 36,
  })

  const text = await session.text({ trimEnd: true })
  expect(text).toMatchInlineSnapshot()
  // ^ run `vitest --run -u` to fill this in, then read the file to see what it captured

  session.close()
}, 10000)
```

### Step 2: Interact and observe again

Add actions and more snapshots incrementally:

```ts
test('bash interaction', async () => {
  const session = await launchTerminal({
    command: 'bash',
    args: ['--norc', '--noprofile'],
    cols: 60,
    rows: 10,
    env: { PS1: '$ ', HOME: '/tmp', PATH: process.env.PATH },
  })

  // observe initial state
  const initial = await session.text({ trimEnd: true })
  expect(initial).toMatchInlineSnapshot()

  // act
  await session.type('echo "hello world"')
  await session.press('enter')

  // wait + observe
  const output = await session.waitForText('hello world')
  expect(output).toMatchInlineSnapshot()

  // cleanup
  await session.type('exit')
  await session.press('enter')
  session.close()
}, 10000)
```

### Step 3: Run with -u, read back, iterate

```bash
# fill in snapshots
vitest --run -u

# read the test file to see captured terminal output
# adjust assertions, add more interactions, repeat
```

This observe-act-observe loop lets you progressively explore any TUI. Each inline snapshot captures the exact terminal state, making tests readable and easy to update.

### Testing a TUI app (e.g. opencode, claude)

```ts
test('opencode shows welcome', async () => {
  const session = await launchTerminal({
    command: 'opencode',
    cols: 150,
    rows: 45,
  })

  await session.waitForText('switch agent', { timeout: 15000 })
  await session.type('hello from tuistory')

  const text = await session.text({ timeout: 1000 })
  expect(text).toMatchInlineSnapshot()

  // navigate menus
  await session.press(['ctrl', 'p'])
  const commands = await session.waitForText('Commands', { timeout: 5000 })
  expect(commands).toMatchInlineSnapshot()

  await session.press('esc')
  session.close()
}, 30000)
```

### Testing a Node.js debugger

```ts
test('node debugger inspect variables', async () => {
  const session = await launchTerminal({
    command: 'node',
    args: ['inspect', 'app.js'],
    cols: 150,
    rows: 45,
  })

  await session.waitForText('Break on start', { timeout: 10000 })
  await session.type('cont')
  await session.press('enter')
  await session.waitForText('break in', { timeout: 5000 })

  const snapshot = await session.text({ trimEnd: true })
  expect(snapshot).toMatchInlineSnapshot()

  session.close()
}, 30000)
```

## Tips

- **Always set a timeout** on `waitForText` for async operations
- **Use `trimEnd: true`** in `session.text()` to avoid trailing whitespace in snapshots
- **Set `waitForData: false`** for interactive commands that don't produce output immediately (like `cat`)
- **Use regex** in `waitForText` for dynamic content: `await session.waitForText(/version \d+/)`
- **Close sessions** in test teardown to avoid leaked processes
- **Use `--cols` and `--rows`** to control terminal size — affects TUI layout
