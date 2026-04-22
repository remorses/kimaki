---
title: Essential Tools Filtering in Kimaki
description: How Kimaki determines which tools are "essential" and filters them based on verbosity level
---

# Essential Tools Filtering in Kimaki

This document explains how Kimaki determines which OpenCode tools are "essential" and how verbosity filtering works to show/hide tool parts in Discord messages.

## Overview

Kimaki implements three verbosity levels for Discord channels:

1. **`text-only`** - Only text responses (the ⬥ diamond messages)
2. **`text-and-essential-tools`** - Text + essential tools (edits, custom MCP tools, etc.)
3. **`tools-and-text`** - All tools shown (complete verbosity)

The `isEssentialToolPart()` function determines whether a tool execution should be shown in `text-and-essential-tools` mode.

## Non-Essential Tools List

**File:** `cli/src/session-handler.ts`, lines 58-73

Non-essential tools are hidden in `text-and-essential-tools` mode:

```typescript
// Built-in tools that are hidden in text-and-essential-tools verbosity mode.
// Essential tools (edits, bash with side effects, todos, tasks, custom MCP tools) are shown; these navigation/read tools are hidden.
const NON_ESSENTIAL_TOOLS = new Set([
  'read',
  'list',
  'glob',
  'grep',
  'todoread',
  'skill',
  'question',
  'webfetch',
])

function isEssentialToolName(toolName: string): boolean {
  return !NON_ESSENTIAL_TOOLS.has(toolName)
}
```

### Non-Essential Tool Categories

- **Read-only navigation:** `read`, `list`, `glob`, `grep` - file discovery/viewing
- **Skill tools:** `skill` - reusable OpenCode skills (loaded from `skills/` in the repo, copied into `cli/skills/` for publishing)
- **Question/Input:** `question` - user interaction tools
- **Documentation:** `webfetch` - web content fetching
- **Todo inspection:** `todoread` - reading todo state (but `todowrite` is essential)

### Essential Tool Categories

Everything NOT in the non-essential list is essential, including:

- **File operations:** `edit`, `write`, `apply_patch` - file modifications
- **Side-effect commands:** `bash` (when hasSideEffect !== false)
- **User interaction:** `todowrite`, `task` - state-changing operations
- **Custom MCP tools:** Any tool not in the built-in non-essential set

## The `isEssentialToolPart()` Function

**File:** `cli/src/session-handler.ts`, lines 75-87

```typescript
function isEssentialToolPart(part: Part): boolean {
  if (part.type !== 'tool') {
    return false
  }
  if (!isEssentialToolName(part.tool)) {
    return false
  }
  if (part.tool === 'bash') {
    const hasSideEffect = part.state.input?.hasSideEffect
    return hasSideEffect !== false
  }
  return true
}
```

### Logic Flow

1. **Type check:** Part must be of type `'tool'`
2. **Tool name check:** Tool must not be in the `NON_ESSENTIAL_TOOLS` set
3. **Bash side-effect check:** For bash tools specifically, only show if `hasSideEffect !== false`
   - This filters out read-only bash commands (e.g., `ls`, `cat`, `grep`)
   - But shows modifying commands (e.g., `mkdir`, `rm`, `chmod`)
4. **Default:** All other tools pass (are essential)

## Verbosity Filtering in `sendPartMessage()`

**File:** `cli/src/session-handler.ts`, lines 880-895

This is where verbosity filtering is applied during message streaming:

```typescript
const sendPartMessage = async (part: Part) => {
  const verbosity = await getVerbosity()
  // In text-only mode, only send text parts (the ⬥ diamond messages)
  if (verbosity === 'text-only' && part.type !== 'text') {
    return
  }
  // In text-and-essential-tools mode, show text + essential tools (edits, custom MCP tools)
  if (verbosity === 'text-and-essential-tools') {
    if (part.type === 'text') {
      // text is always shown
    } else if (part.type === 'tool' && isEssentialToolPart(part)) {
      // essential tools are shown
    } else {
      return
    }
  }

  const content = formatPart(part) + '\n\n'
  if (!content.trim() || content.length === 0) {
    // Skip empty content
    return
  }
  // ... send message to Discord
}
```

### Verbosity Decision Logic

| Verbosity Mode             | Text Parts | Essential Tools | Non-Essential Tools | Other Parts         |
| -------------------------- | ---------- | --------------- | ------------------- | ------------------- |
| `text-only`                | ✓ Show     | ✗ Skip          | ✗ Skip              | ✗ Skip              |
| `text-and-essential-tools` | ✓ Show     | ✓ Show          | ✗ Skip              | ? (reasoning, etc.) |
| `tools-and-text`           | ✓ Show     | ✓ Show          | ✓ Show              | ✓ Show (all types)  |

### Key Points

- Verbosity is read **dynamically** during streaming: `const verbosity = await getVerbosity()`
- This allows `/verbosity` command changes to take effect **immediately** during an ongoing session
- Only `text-only` and `text-and-essential-tools` apply filtering
- `tools-and-text` (default) shows everything

## Tool Formatting: Skill Tools

**File:** `cli/src/message-formatting.ts`, lines 346-349

Skill tools are formatted with italics and the skill name:

```typescript
if (part.tool === 'skill') {
  const name = (part.state.input?.name as string) || ''
  return name ? `_${escapeInlineMarkdown(name)}_` : ''
}
```

Example Discord output:

- Tool summary line: `┣ _skill-name_`
- The skill name is italicized

## Skill Tool Configuration

**File:** `cli/src/opencode.ts`, lines 182-183

Skills are loaded from the local filesystem:

```typescript
skills: {
  paths: [resolveBundledSkillsDir()],
}
```

Skills are discovered from the repository root `skills/` directory and copied into `cli/skills/` during build/publish (see `scripts/sync-skills.ts` and `scripts/prepare-skills.ts`).

## Other Verbosity Filtering Uses

Verbosity filtering is also used for:

1. **Large output notifications** (lines 1126-1134) - Only notify about tool output if visible
2. **Context compaction filtering** (lines 1193-1200) - Only report tool parts in context usage if they're visible

## Database

**File:** `cli/src/database.ts`, lines 388-413

Verbosity settings are stored per-channel in SQLite:

```typescript
export async function getChannelVerbosity(
  channelId: string,
): Promise<VerbosityLevel> {
  const row = await prisma.channel_verbosity.findUnique({
    where: { channel_id: channelId },
  })
  if (row?.verbosity) {
    return row.verbosity as VerbosityLevel
  }
  return config.defaultVerbosity
}

export async function setChannelVerbosity(
  channelId: string,
  verbosity: VerbosityLevel,
): Promise<void> {
  await prisma.channel_verbosity.upsert({
    where: { channel_id: channelId },
    create: { channel_id: channelId, verbosity },
    update: { verbosity, updated_at: new Date() },
  })
}
```

## Verbosity Command

**File:** `cli/src/commands/verbosity.ts`

The `/verbosity` command allows users to set channel-level verbosity:

```bash
/verbosity text-only                 # Only show text responses
/verbosity text-and-essential-tools  # Show text + key tools
/verbosity tools-and-text            # Show everything
```

Can also be set globally via CLI flag at startup:

```bash
kimaki --verbosity text-and-essential-tools
```

## Summary

**Essential tools are:**

- File edits, writes, patches
- Side-effect bash commands
- Todo/task state changes
- Any custom MCP tools (user-defined)

**Non-essential tools are:**

- File reading (`read`, `list`, `glob`, `grep`)
- Skill tool invocations
- User questions
- Web fetching

**Filtering happens at:**

1. `isEssentialToolPart()` - Determines if a tool part is essential
2. `sendPartMessage()` - Applies verbosity filter during streaming
3. Large output notifications and context reporting - Also respect verbosity
