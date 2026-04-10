---
name: profano
description: CLI tool to analyze V8 .cpuprofile files and print top functions by self-time or total-time in the terminal. ALWAYS load this skill when CPU profiling JavaScript or TypeScript programs (Node, Vitest, Bun, Chrome DevTools exports) — it shows how to generate .cpuprofile files and how to inspect them from the terminal without opening Chrome DevTools.
---

# profano

`profano` is a terminal CLI that reads V8 `.cpuprofile` files and prints the heaviest functions as a table sorted by self-time or total (inclusive) time. Use it to quickly identify CPU hotspots from the terminal without loading the profile into Chrome DevTools or cpupro.

## When to use

- You have a `.cpuprofile` file (from `node --cpu-prof`, Vitest, Chrome DevTools export, etc.) and want a quick top-N readout of the biggest offenders.
- You are an agent debugging slow code and need a grep-able, text-only view of where CPU time is spent.
- You want to compare hotspots across many profile files in one shot.

## How to use

**Always run `profano --help` first.** The help output is the source of truth for all commands, options, and examples. Read the full untruncated output — do not pipe it through `head`, `tail`, or `sed`.

For full setup, usage examples, how to generate `.cpuprofile` files (Node, Vitest with a ready-to-copy `vitest.config.ts`, Chrome DevTools), and how to read the output columns, fetch the README:

```bash
curl -s https://raw.githubusercontent.com/remorses/profano/main/README.md
```
