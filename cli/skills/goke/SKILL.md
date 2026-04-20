---
name: goke
description: >
  goke is a zero-dependency, type-safe CLI framework for TypeScript. CAC replacement
  with Standard Schema support (Zod, Valibot, ArkType). Use goke when building CLI
  tools — it handles commands, subcommands, options, type coercion, help generation,
  and more. Schema-based options give you automatic type inference, coercion from
  strings, and help text generation. ALWAYS read this skill when a repo uses goke
  for its CLI.
version: 0.0.1
---

# goke

Fetch the full README from GitHub and read it before using goke:

```bash
curl -L https://raw.githubusercontent.com/remorses/goke/main/README.md
```

> Read the README in full every time you use goke.
>
> Important: never use `head` or `tail` to truncate it. Read the full README instead.

## Install

```bash
npm install goke
```

## Quick Notes

- Core APIs: `cli.option`, `cli.use`, `cli.version`, `cli.help`, `cli.parse`
- Prefer injected `{ fs, console, process }` over globals
- Use relative paths with injected `fs`; if a helper needs current-cwd semantics, pass injected `process.cwd` into that helper
- For JustBash compatibility tests, import the existing CLI from app code instead of defining a new CLI inside the test

The README is the source of truth for rules, examples, testing patterns, JustBash integration, and API details.

## Interactive Prompts with @clack/prompts

Use `@clack/prompts` for interactive CLI prompts (select, confirm, text input). It provides a polished UI compared to raw `readline`.

```bash
npm install @clack/prompts
```

```ts
import * as clack from '@clack/prompts'

// Select between options
const method = await clack.select({
  message: 'Choose authentication method',
  options: [
    { value: 'google', label: 'Google', hint: 'opens browser for OAuth' },
    { value: 'imap', label: 'Other', hint: 'IMAP/SMTP with password' },
  ],
})
if (clack.isCancel(method)) process.exit(0)

// Yes/no confirmation
const confirmed = await clack.confirm({
  message: 'Delete this item?',
  initialValue: false,
})
if (clack.isCancel(confirmed) || !confirmed) {
  console.error('Cancelled')
  return
}
```

> **IMPORTANT: Always guard clack prompts with `process.stdin.isTTY`.**
>
> Agents and CI pipelines run with non-TTY stdin. If you call clack without this guard, it will hang or render garbage output in piped/non-interactive environments. Every clack prompt must be wrapped in a TTY check.

### Select prompts — mirror as a CLI option

When a command shows a `select` prompt in TTY mode, **always add a matching CLI option** so agents can pass the choice directly without a prompt. In non-TTY without the option, exit with an error telling the user how to rerun:

```ts
cli
  .command('login', 'Authenticate')
  .option('--method <method>', z.enum(['google', 'imap']).optional().describe('Authentication method'))
  .action(async (options) => {
    let method = options.method

    if (!method) {
      if (!process.stdin.isTTY) {
        // Non-TTY and no option passed: tell the user how to run non-interactively
        out.error('Run non-interactively with: zele login --method google|imap')
        process.exit(1)
      }
      // TTY: show the interactive select
      const choice = await clack.select({
        message: 'Choose authentication method',
        options: [
          { value: 'google', label: 'Google', hint: 'opens browser for OAuth' },
          { value: 'imap', label: 'Other', hint: 'IMAP/SMTP with password' },
        ],
      })
      if (clack.isCancel(choice)) process.exit(0)
      method = choice
    }

    if (method === 'imap') { /* ... */ }
    // proceed with method
  })
```

This way agents pass `--method google` and skip the prompt entirely, while humans get the nice interactive select.

### Confirm prompts — use `--force` to skip

For destructive confirmations, add a `--force` flag and exit with an error in non-TTY when it's missing:

```ts
cli
  .command('delete <id>', 'Delete an item')
  .option('--force', 'Skip confirmation')
  .action(async (id, options) => {
    if (!options.force) {
      if (!process.stdin.isTTY) {
        out.error('Use --force to delete non-interactively')
        process.exit(1)
      }
      const confirmed = await clack.confirm({ message: `Delete ${id}?`, initialValue: false })
      if (clack.isCancel(confirmed) || !confirmed) return
    }
    // proceed with deletion
  })
```

Agents pass `--force` to skip the confirm. In non-TTY without `--force`, the command exits with a clear error instead of hanging or silently proceeding.
