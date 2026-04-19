---
name: tuistory
description: |
  Control and monitor terminal applications. Supports running TUI processes in background. TMUX replacement for agents. Can control fully interactive TUI apps like claude or opencode.

  Use tuistory and read the skill when you need to:
  - Run background processes for agents like dev servers. prefer it over `tmux` because it waits for real output instead of guessing with `sleep`
  - Control interactive CLIs and TUIs by typing, pressing keys, clicking, waiting, and taking snapshots
  - Write Playwright-style tests for terminal apps with `vitest` or `bun:test`

  It has **2 modes**:
  - **CLI** (`tuistory`) for persistent background sessions and terminal automation. **Run `tuistory --help` first.**
  - **JS/TS API** (`launchTerminal`) for writing tests (like playwright for TUIs) and programmatic control in scripts.
---

# tuistory

Playwright for terminal apps. Use it to run background processes for agents, drive interactive TUIs, and write Playwright-style tests for CLIs and TUIs.

Prefer tuistory over `tmux` for agent automation. It is better because it reacts to terminal output with `wait` and `wait-idle` instead of wasting time on blind `sleep` calls. That makes scripts both faster and more reliable.

Every time you use tuistory, you MUST run these two commands first. NEVER pipe to head/tail, read the full output:

```bash
# CLI help — source of truth for commands, options, and syntax
tuistory --help

# Full README with API docs, examples, and testing patterns
curl -s https://raw.githubusercontent.com/remorses/termcast/refs/heads/main/README.md
```

## Key rules

- Always run `snapshot --trim` after every CLI action to see the current terminal state
- Always set a timeout on `waitForText` for async operations
- String patterns are case-sensitive by default. Use regex like `/ready/i` when casing may vary.
- Use `trimEnd: true` in `session.text()` to avoid trailing whitespace in snapshots
- Close sessions in test teardown to avoid leaked processes
- Use `--cols` and `--rows` to control terminal size — affects TUI layout
- Use `--pixel-ratio 2` for sharp screenshot images

## Feedback loop

Use an **observe → act → observe** loop, like Playwright but for terminals.

### Background process instead of tmux

```bash
# start a server in the background
tuistory launch "bun run dev" -s dev

# wait for actual output instead of sleep 5
# use regex so this still matches Ready, READY, etc.
tuistory -s dev wait "/ready/i" --timeout 30000

# read everything the process printed
tuistory read -s dev

# later, read only the new output
tuistory read -s dev
```

Why this is better than `tmux`:

- no blind `sleep`
- reacts as soon as output appears
- faster when apps start quickly
- more reliable when apps start slowly

### Interactive TUI loop

```bash
# observe
tuistory -s app snapshot --trim

# act
tuistory -s app press enter

# observe again
tuistory -s app snapshot --trim
```

### Test loop with JS/TS API

```ts
const session = await launchTerminal({ command: 'my-cli', cols: 120, rows: 36 })

const initial = await session.text({ trimEnd: true })
expect(initial).toMatchInlineSnapshot()

await session.type('hello')
await session.press('enter')

const output = await session.waitForText('hello', { timeout: 5000 })
expect(output).toMatchInlineSnapshot()

session.close()
```
