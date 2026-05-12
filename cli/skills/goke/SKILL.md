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
npm install goke # or bun, pnpm, etc
```

## Quick Notes

- Core APIs: `cli.option`, `cli.use`, `cli.version`, `cli.help`, `cli.parse`
- Prefer injected `{ fs, console, process }` over globals
- Use relative paths with injected `fs`; if a helper needs current-cwd semantics, pass injected `process.cwd` into that helper
- For JustBash compatibility tests, import the existing CLI from app code instead of defining a new CLI inside the test
- **Never install a separate color library** (`picocolors`, `chalk`, `kleur`). goke ships `colors` with the full picocolors API. Import it: `import { colors } from 'goke'`. Supports `bold`, `dim`, `italic`, `underline`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `gray`, `bgRed`, `bgGreen`, etc. Auto-detects `NO_COLOR`, `FORCE_COLOR`, `--no-color`, `--color`, and TTY state.

The README is the source of truth for rules, examples, testing patterns, JustBash integration, and API details.
