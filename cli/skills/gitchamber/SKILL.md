---
name: gitchamber
description: CLI to download npm packages, PyPI packages, crates, or GitHub repo source code into node_modules/.gitchamber/ for analysis. Use when you need to read a package's inner workings, documentation, examples, or source code. Alternative to opensrc that stores in node_modules/ for zero-config gitignore/vitest/tsc compatibility. After fetching, analyze files with grep, read, and other tools.
---

# gitchamber

CLI to download source code for npm packages, PyPI packages, crates.io crates, or GitHub repos into `node_modules/.gitchamber/`. After fetching, analyze the files using grep, read, glob, and other tools to understand inner workings, find usage examples, read documentation, or study the source code.

Alternative to [opensrc](https://github.com/vercel-labs/opensrc) that stores in `node_modules/` instead of `opensrc/`.

**Differences from opensrc:**

- **Stores in `node_modules/.gitchamber/`** instead of `opensrc/` -- automatically ignored by git, vitest, tsc, linters, bundlers, and every other tool that skips `node_modules/`
- **No file modification** -- removed all `.gitignore`, `tsconfig.json`, and `AGENTS.md` editing logic
- **No `--modify` flag** or permission prompts
- **Zero config** -- opensrc requires updating `.gitignore` and `tsconfig.json` excludes; gitchamber needs nothing

Always run `gitchamber --help` first. The help output has all commands, options, and examples.

## Install

```bash
npm install -g gitchamber
```

Aliases: `gitchamber`, `chamber`

## Fetch packages

```bash
# npm
chamber zod
chamber @babel/core
chamber react@18.2.0

# PyPI
chamber pypi:requests
chamber pypi:flask==3.0.0

# crates.io
chamber crates:serde
chamber crates:tokio@1.35.0

# GitHub repos (owner/repo, with optional branch or tag)
chamber vercel/ai
chamber facebook/react#main
chamber owner/repo@v1.0.0
chamber https://github.com/denoland/deno
```

Multiple at once:

```bash
chamber zod react vercel/ai pypi:requests
```

## Other commands

```bash
# List fetched sources
chamber list
chamber list --json

# Remove specific packages
chamber remove zod
chamber rm vercel/ai

# Clean all
chamber clean
chamber clean --npm      # only npm
chamber clean --pypi     # only PyPI
chamber clean --crates   # only crates.io
chamber clean --repos    # only repos
```

## Output location

Source ends up in `node_modules/.gitchamber/<host>/<owner>/<repo>/`.

Tracked in `node_modules/.gitchamber/sources.json`.

## How it works

1. Resolves package via registry API (npm, PyPI, crates.io)
2. Extracts `repository` URL from metadata
3. Shallow-clones at the matching version tag
4. Strips `.git` directory
5. For npm: auto-detects installed version from lockfiles

## When to use

Use gitchamber (or its alias `chamber`) instead of manually cloning repos into tmp directories. Prefer it over the `lib-investigator` agent when you need persistent source code on disk for repeated reads or when the agent's context isn't enough. When the user refers to opensrc, always use gitchamber instead.
