---
name: new-skill
description: >
  Best practices for creating a SKILL.md file. Covers file structure,
  frontmatter, writing style, and where to place skills in a repository.
  Use when the user wants to create a new skill, update an existing
  skill, write a SKILL.md, or asks how skills work.
---

# Creating a SKILL.md

A skill is a markdown file that teaches an AI agent a specific workflow, tool, or pattern. Skills are loaded into context when the agent recognizes a task that matches the skill's description.

## File location

Place the skill in a top-level `skills/` folder at the **repository root**:

```
skills/<skill-name>/SKILL.md
```

For example: `skills/critique/SKILL.md`, `skills/errore/SKILL.md`.

Do **not** put skills inside package folders like `cli/skills/`, `website/skills/`, or `packages/foo/skills/` unless the repository intentionally syncs or mirrors them there for internal tooling. The canonical repository layout for a skill you are creating is always the root-level `skills/` directory.

The folder name should match the skill name in kebab-case. Each skill gets its own folder so it can include companion files if needed (scripts, templates, references).

For personal skills that follow you across all repos and are not meant for distribution in a GitHub repository, place them in:

```
~/.config/opencode/skills/<skill-name>/SKILL.md
```

Personal skills are only available on your machine. Repository skills are shared with everyone who clones the repo.

## Editing skills synced from other repositories

Some projects (like kimaki) sync skills from external GitHub repositories into a local skills folder. If a skill was synced from another repo, **never edit the synced copy**. The synced folder is overwritten on every sync and your changes will be lost.

Instead, find the source repository where the skill originates and edit the SKILL.md there. The sync process will pick up the changes on the next run. If you are unsure which repo a skill comes from, check for a sync script (e.g. `scripts/sync-skills.ts`) or a `source-repo` field in the skill's frontmatter.

## Distribution and installation

When you publish skills in a GitHub repository, other users can install them with the `skills` CLI:

```bash
npx skills add owner/repo
```

This downloads the skills from the repo and symlinks them into the user's agent directories. Add this to your repo's README so users know how to install:

```markdown
## Install skill for AI agents

\`\`\`bash
npx -y skills add owner/repo
\`\`\`

This installs [skills](https://skills.sh) for AI coding agents like
Claude Code, Cursor, Windsurf, and others. Skills teach agents the
workflows, patterns, and tools specific to this project.
```

## Frontmatter

Every SKILL.md starts with YAML frontmatter containing two required fields:

```yaml
---
name: skill-name
description: >
  One to three sentences explaining what this skill does and when to use it.
  Start with a noun or verb phrase. Include trigger conditions so the agent
  knows when to load this skill automatically.
---
```

- **name**: kebab-case identifier matching the folder name
- **description**: this is the most important field. The agent reads descriptions of all available skills and decides which to load based on this text. Be specific about when the skill applies. Include keywords the user might say.

Good description example:
```yaml
description: >
  Git diff viewer. Renders diffs as web pages, images, and PDFs
  with syntax highlighting. Use this skill when working with critique
  for showing diffs, generating diff URLs, or selective hunk staging.
```

Bad description example:
```yaml
description: A helpful tool for developers.
```

## File structure

After the frontmatter, write the skill as a normal markdown document. Follow this general structure:

```markdown
# Skill Title

One paragraph explaining what this skill is and why it exists.

## Key section

Core rules, commands, or patterns. Use code blocks for commands
and examples. Use numbered lists for sequential steps.

## Another section

More detail, edge cases, gotchas, tips.
```

There is no rigid template. Structure the content in whatever way communicates the workflow most clearly. Some skills are short (20 lines for a simple CLI tool), others are long (600+ lines for a complex pattern like errore).

## Writing style

**Write for an AI agent, not a human.** The reader is a language model that will follow these instructions while helping a user. This changes how you write:

- **Be direct and imperative.** Say "Always run `tool --help` first" not "You might want to consider running the help command."
- **Include concrete commands and code.** The agent needs copy-pasteable examples, not abstract descriptions.
- **State rules as rules.** Use "Never", "Always", "Must" when something is non-negotiable.
- **Show the right way, not just the wrong way.** After saying what not to do, immediately show what to do instead.
- **Use code blocks with language hints.** The agent uses these to generate correct code.
- **Keep prose short between code blocks.** One or two sentences of explanation, then an example.
- **Call out common mistakes.** If there is a gotcha the agent will likely hit, warn about it explicitly.

## What makes a good skill

A good skill captures **hard-won knowledge** that is not obvious from reading docs or source code alone. Focus on:

- **Correct usage patterns** — the commands and code that actually work, not just what the docs say
- **Gotchas and edge cases** — things that break in subtle ways (e.g. "libsql transaction() with file::memory: silently uses a separate empty database unless you add ?cache=shared")
- **Opinionated defaults** — when there are multiple ways to do something, state which way to use and why
- **Integration context** — how this tool fits into the broader workflow (e.g. "Always use critique when showing diffs to Discord users because they cannot see terminal output")

A bad skill is just a copy of the tool's README or man page. If the agent could figure it out from `--help`, it does not need a skill for it.

## Keep the SKILL.md thin — point at canonical docs

The best skills are **thin**. They contain almost no documentation themselves. Their only job is to tell the agent where to find the full, fresh docs and to forbid truncation. This keeps docs in one place and stops the skill from going stale.

There are two variants:

**1. CLI tools → run `<tool> --help`**

Put as much documentation as possible into the CLI itself — command descriptions, option help text, examples. The skill then says:

```markdown
Every time you use mytool, you MUST run:

\`\`\`bash
mytool --help # NEVER pipe to head/tail, read the full output
\`\`\`
```

Exception: some CLIs have a dedicated `<tool> skill` subcommand when `--help` is not rich enough (e.g. `playwriter skill`). Prefer `--help` by default and only use a custom subcommand when the CLI ships one.

**2. Libraries and projects → curl the raw README**

For libraries, frameworks, and pattern skills, keep the canonical docs in `README.md` and have the skill curl the raw file from the main branch so the agent always reads the latest version:

```markdown
Every time you work with myproject, you MUST fetch the latest README:

\`\`\`bash
curl -s https://raw.githubusercontent.com/owner/repo/main/README.md # NEVER pipe to head/tail
\`\`\`
```

**In monorepos/workspaces, always put the README at the repository root** — not inside individual package folders. Package-level READMEs don't get read by anyone. One root README is the single source of truth for the whole project. The skill should curl the root README path (`.../main/README.md`), not a package subdirectory.

**Never truncate docs output.** The agent must read `--help` and curl'd README output **in full**. Never pipe through `head`, `tail`, `sed -n`, `awk`, `| less`, or any command that strips or limits lines. Critical rules are spread throughout the doc, not just at the top. Agents truncate frequently and miss important context — forbid it explicitly in the skill body.

## Examples from real skills

**Simple CLI tool skill** (gitchamber — 93 lines):
```markdown
---
name: gitchamber
description: CLI to download npm packages, PyPI packages, crates, or GitHub
  repo source code into node_modules/.gitchamber/ for analysis. Use when you
  need to read a package's inner workings, documentation, examples, or source
  code.
---

# gitchamber

CLI to download source code for npm packages, PyPI packages, crates.io
crates, or GitHub repos into `node_modules/.gitchamber/`.

Always run `gitchamber --help` first. The help output has all commands,
options, and examples.

## Fetch packages

\`\`\`bash
chamber zod
chamber pypi:requests
chamber github:owner/repo
\`\`\`
```

**Pattern/convention skill** (errore — 647 lines):
```markdown
---
name: errore
description: >
  errore is Go-style error handling for TypeScript: return errors instead
  of throwing them. ALWAYS read this skill when a repo uses the errore
  "errors as values" convention.
---

# errore

Go-style error handling for TypeScript. Functions return errors instead
of throwing them.

## Rules

1. Always `import * as errore from 'errore'` — namespace import
2. Never throw for expected failures — return errors as values
3. Use `createTaggedError` for domain errors
...
```

Notice both follow the same pattern: minimal frontmatter, clear title, actionable content with code examples. The simple tool skill is short and focused on commands. The pattern skill is long and focused on rules and conventions.

## Checklist

Before saving a new skill:

1. Does the **description** clearly state when to load this skill? Would an agent reading just the description know whether to load it?
2. Does the **name** match the folder name?
3. Does the skill **point at a single source of truth** (README curl URL or `--help` command) instead of duplicating docs inline?
4. Is there an explicit **"never truncate"** rule next to any docs command?
5. Are there **concrete code examples** for the main workflows?
6. Did you capture the **gotchas** — the things that took trial and error to figure out?
