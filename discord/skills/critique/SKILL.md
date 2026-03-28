---
name: critique
description: >
  Git diff viewer and AI reviewer. Renders diffs as web pages, images, and PDFs
  with syntax highlighting. Also provides AI-powered diff reviews via
  `critique review --web`. Use this skill when working with critique for showing
  diffs, generating diff URLs, selective hunk staging, or AI code reviews.
---

# critique

Git diff viewer that renders diffs as **web pages**, **images**, and **PDFs** with syntax highlighting.

Agents running in headless environments (kimaki on Discord, openclaw on Slack/Telegram) have no terminal to show diffs. critique uploads diffs to critique.work and returns a shareable URL you can paste into chat. Users click the link and see a syntax-highlighted split-view diff with mobile support and dark/light mode — no install needed.

**Always run `critique --help` first** to see the latest flags and commands. The help output is the source of truth.

## Web — shareable diff URLs

Always pass a title to describe what the diff contains.

```bash
# Working tree changes
critique --web "Add retry logic to database connections"

# Staged changes
critique --staged --web "Refactor auth middleware"

# Branch diff (three-dot: changes since diverging from base)
critique main...HEAD --web "Feature branch changes"
critique main...feature-branch --web "Compare branches"

# Last N commits
critique HEAD~3 --web "Recent changes"

# Specific commit
critique --commit HEAD --web "Latest commit"
critique --commit abc1234 --web "Fix race condition"

# Filter to specific files
critique --web "API changes" --filter "src/api.ts" --filter "src/utils.ts"

# JSON output for programmatic use (returns {url, id, files})
critique --web "Deploy changes" --json
```

Share the returned URL with the user so they can see the diff.

## PDF

```bash
critique --pdf                              # working tree to PDF
critique --staged --pdf                     # staged changes
critique main...HEAD --pdf                   # branch diff
critique --commit HEAD --pdf                # single commit
critique --pdf output.pdf                   # custom filename
critique --pdf --pdf-page-size a4-portrait  # page size options
critique main...HEAD --pdf --open            # open in viewer
```

## Image

```bash
critique --image              # renders to /tmp as WebP
critique main...HEAD --image  # branch diff as images
```

## Selective hunk staging

When multiple agents work on the same repo, each agent should only commit its own changes. `critique hunks` lets you stage individual hunks instead of whole files — like a scriptable `git add -p`.

```bash
# List hunks with stable IDs
critique hunks list
critique hunks list --filter "src/**/*.ts"

# Stage specific hunks by ID
critique hunks add 'src/main.ts:@-10,6+10,7'
critique hunks add 'src/main.ts:@-10,6+10,7' 'src/utils.ts:@-5,3+5,4'
```

Hunk ID format: `file:@-oldStart,oldLines+newStart,newLines` — derived from the `@@` diff header, stable across runs.

**Typical workflow:**

```bash
critique hunks list                          # see all unstaged hunks
critique hunks add 'file:@-10,6+10,7'       # stage only your hunks
git commit -m "your changes"                 # commit separately
```

## AI-powered diff review

`critique review --web` spawns a separate opencode session that analyzes a diff, groups related
changes, and produces a structured review with explanations, diagrams, and suggestions. Uploads
the result as a shareable URL — much richer than a plain diff link.

**This command is very slow (up to 20 minutes for large diffs).** Only run when the user
explicitly asks for a code review or diff explanation. Warn the user it will take a while.
Set Bash tool timeout to at least 25 minutes (`timeout: 1_500_000`).

Always pass `--agent opencode` and `--session <current_session_id>` so the reviewer has context
about why the changes were made. If you know other session IDs that produced the diff, pass them
too with additional `--session` flags.

```bash
# Review working tree changes
critique review --web --agent opencode --session <session_id>

# Review a specific commit
critique review --commit HEAD --web --agent opencode --session <session_id>

# Review branch changes compared to main
critique review main...HEAD --web --agent opencode --session <session_id>

# Review with multiple session contexts
critique review --commit abc1234 --web --agent opencode --session <session_id> --session <other_session_id>

# Review only specific files
critique review --web --agent opencode --session <session_id> --filter "src/**/*.ts"
```

The command prints a preview URL when done — share that URL with the user.

## Fetching user comments (annotations)

Users can add line-level comments on any critique diff page via the Agentation widget (bottom-right corner of the diff page). To fetch those comments as markdown (optimized for agents/LLMs):

```bash
curl https://critique.work/v/<id>/annotations
```

Returns `text/markdown` with each annotation showing the file, line, and comment text. Use this when the user says they left comments on a critique diff and you need to read them.

## Raw patch access

Every `--web` upload also stores the raw unified diff. Append `.patch` to any critique URL to get it:

```bash
# View the raw patch
curl https://critique.work/v/<id>.patch

# Apply the patch to current repo
curl -s https://critique.work/v/<id>.patch | git apply

# Reverse the patch (undo the changes)
curl -s https://critique.work/v/<id>.patch | git apply --reverse
```

Useful when an agent shares a critique URL and you want to programmatically apply or revert those changes.

## Notes

- Requires **Bun** — use `bunx critique` or global `critique`
- Lock files and diffs >6000 lines are auto-hidden
- `--web` URLs expire after 7 days (content-hashed, same diff = same URL)
