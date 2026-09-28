---
name: opensrc
description: Fetch dependency source code to give AI agents deeper implementation context. Use when the agent needs to understand how a library works internally, read source code for a package or GitHub repo, fetch implementation details for a dependency, or explore how an npm/PyPI/crates.io package is built. Triggers include "fetch source for", "read the source of", "read this GitHub repo", "how does X work internally", "get the implementation of", "opensrc path", or any task requiring access to dependency source code beyond types and docs. ALWAYS load this skill before running any `opensrc` command. opensrc caches forever with no TTL, so a cached clone can be weeks or months old. ALWAYS reclone any cached source older than 2 days before reading it (see the freshness check in this skill). Reading a stale clone gives wrong answers about current code.
allowed-tools: Bash(opensrc:*)
---

# Source Code Fetching with opensrc

Fetches dependency source code so agents can read implementations, not just types. Clones repositories at the correct version tag and caches them globally at `~/.opensrc/`.

## Required: fresh clone first

**Never read a cached clone older than 2 days.** opensrc has no TTL. A plain `opensrc path` can return a clone that is months old, and you will describe code that no longer exists. Always get the path with this check, never with a bare `opensrc path`:

```bash
SPEC=owner/repo   # or zod, pypi:requests, crates:serde, owner/repo#main
SRC=$(opensrc path "$SPEC")
if find "$SRC" -maxdepth 0 -mtime +2 | grep -q .; then
  opensrc remove "$SPEC"
  SRC=$(opensrc path "$SPEC")
fi
echo "$SRC"
```

When you report findings from a repo, say which version or date you read (for example the `version` in `package.json` or the fetch date), so the user can see if it is current.

## Core Pattern

```bash
rg "parse" $(opensrc path zod)
cat $(opensrc path zod)/src/types.ts
find $(opensrc path zod) -name "*.test.ts"
```

`opensrc path <pkg>` prints the absolute path to cached source. If not cached, it fetches automatically. Progress goes to stderr, path to stdout, so `$(opensrc path ...)` works in subshells. The one-liners above are for sources you already refreshed with the freshness check in this session.

## Fetching Source Code

```bash
opensrc path zod
opensrc path pypi:requests
opensrc path crates:serde
opensrc path facebook/react

# Multiple packages at once
opensrc path zod react next
opensrc path pypi:requests pypi:flask
opensrc path crates:serde crates:tokio

# Specific versions
opensrc path zod@3.22.0
opensrc path pypi:flask@3.0.0
opensrc path owner/repo@v1.0.0
opensrc path owner/repo#main
```

### Version Resolution

For npm packages, opensrc auto-detects the installed version from lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`). Use `--cwd` to resolve from a different project:

```bash
opensrc path zod --cwd /path/to/project
```

For PyPI and crates.io, explicit versions or latest are used. For repos, use `@ref` or `#ref` to pin a branch, tag, or commit.

## Managing the Cache

Source is cached globally at `~/.opensrc/` (override with `OPENSRC_HOME`). opensrc has **no TTL**. A cache hit is forever if the version/ref folder still exists. After clone it deletes `.git`, so you cannot `git pull`. Reclone by removing first.

```bash
opensrc list                     # show all cached sources (includes Fetched date)
opensrc list --json              # JSON with fetchedAt ISO timestamps

opensrc remove zod               # remove a package
opensrc remove facebook/react    # remove a repo

opensrc clean                    # remove everything
opensrc clean --npm              # only npm packages
opensrc clean --pypi             # only PyPI packages
opensrc clean --crates           # only crates.io packages
opensrc clean --packages         # all packages, keep repos
opensrc clean --repos            # all repos, keep packages
```

### Reclone if older than 2 days

This rule is mandatory (see "Required: fresh clone first" at the top). It matters most for unpinned / branch refs (`owner/repo`, `owner/repo#main`), which move every day. Pinned tags (`zod@3.22.0`) stay the same, but still follow this rule so you do not keep a deleted folder.

`find -maxdepth 0 -mtime +2` prints the path only when the clone dir is older than 2 days.

**Authoritative age:** `fetchedAt` in `opensrc list --json` (also `~/.opensrc/sources.json`). Compare that ISO time to now. `opensrc list` prints `Fetched: Mar 20, 2026` (date only).

## When to Fetch Source

Fetch source when you need to:
- Understand internal behavior that types don't reveal
- Debug unexpected library behavior
- Learn patterns from well-known implementations
- Verify how a function handles edge cases

Don't fetch source for simple API usage questions that docs or types can answer.
