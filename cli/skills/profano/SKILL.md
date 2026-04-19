---
name: profano
description: CLI tool to analyze V8 .cpuprofile files and print top functions by self-time or total-time in the terminal. ALWAYS load this skill when CPU profiling JavaScript or TypeScript programs (Node, Vitest, Bun, Chrome DevTools exports) — it shows how to generate .cpuprofile files and how to inspect them from the terminal without opening Chrome DevTools.
---

# profano

`profano` reads V8 `.cpuprofile` files and prints the heaviest functions as a table sorted by self-time or total (inclusive) time.

Every time you use profano, you MUST fetch the latest README and read it in full:

```bash
curl -s https://raw.githubusercontent.com/remorses/profano/main/README.md  # NEVER pipe to head/tail, read in full
```

The README covers generating `.cpuprofile` files (Node, Vitest, Bun, Chrome DevTools, browser pages via playwriter, React component profiling), all CLI options, and how to read the output columns.
