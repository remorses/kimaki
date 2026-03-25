<div align='center'>
    <br/>
    <br/>
    <h3>kimaki</h3>
    <p>Iron Man's Jarvis for coding agents, inside Discord</p>
    <br/>
    <br/>
</div>

Kimaki is a Discord bot that lets you control [OpenCode](https://opencode.ai) coding sessions from Discord. Send a message in a Discord channel, an AI agent edits code on your machine.

## Quick Start

```bash
npx -y kimaki@latest
```

The CLI walks you through everything. Setup takes about 1 minute — you install the Kimaki bot to your Discord server with one click, pick your projects, and you're done.

## What is Kimaki?

Kimaki connects Discord to [OpenCode](https://opencode.ai), a coding agent similar to Claude Code. Each Discord channel is linked to a project directory on your machine. When you send a message in that channel, Kimaki creates a thread and starts an OpenCode session that can:

- Read and edit files
- Run terminal commands
- Search your codebase
- Use any tools you've configured

Think of it as texting your codebase. You describe what you want, the AI does it.

```
┌─────────────┐         ┌─────────────────────────────────────────┐
│   Discord   │         │  Your Machine                           │
│             │         │                                         │
│  You send a │─────────▶  Kimaki CLI ──▶ OpenCode Server ──▶ AI  │
│  message in │         │                    │                    │
│  a channel  │◀────────│     responses      ▼                    │
│             │         │              Reads, edits, and          │
└─────────────┘         │              runs commands in           │
                        │              your project directory     │
                        └─────────────────────────────────────────┘
```

## Setup

Run the CLI and follow the interactive prompts:

```bash
npx -y kimaki@latest
```

The setup wizard gives you two options:

- **Gateway mode (default)** — Uses Kimaki's pre-built Discord bot. No Discord Developer Portal setup needed. You click one install link, authorize the bot in your server, and you're running. This is the recommended path.
- **Self-hosted mode** — You create your own Discord bot at [discord.com/developers](https://discord.com/developers/applications). Takes 5-10 minutes. Useful if you want full control over the bot identity.

Both modes work identically after setup. Keep the CLI running — it's the bridge between Discord and your machine.

## Features

**Text messages** — Send any message in a channel linked to a project. Kimaki creates a thread and starts an OpenCode session.

**File attachments** — Attach images, code files, or any other files to your message. Kimaki includes them in the session context.

**Voice messages** — Record a voice message in Discord. Kimaki transcribes it using Google's Gemini API and processes it as text. The transcription uses your project's file tree for accuracy, recognizing function names and file paths you mention. Requires a Gemini API key (prompted during setup).

**Session management** — Resume sessions where you left off, fork from any message, or generate public URLs to share your session.

**Message queue** — Use `/queue <message>` to queue a follow-up while the AI is still responding. It sends automatically when the current response finishes. You can also end any message with `. queue` for the same behavior.

**Memory** — Kimaki reads a `MEMORY.md` file from your project root at session start. The AI can update this file to store learnings, decisions, and context worth preserving across sessions.

**Tool permissions** — When the AI tries to run something that needs approval (like shell commands or accessing files outside the project), Kimaki shows Accept / Accept Always / Deny buttons in the thread. Customize defaults in your project's `opencode.json`. See [OpenCode Permissions docs](https://opencode.ai/docs/permissions/).

## Commands

### Slash Commands

| Command | Description |
|---|---|
| `/session <prompt>` | Start a new session with an initial prompt |
| `/resume <session>` | Resume a previous session (with autocomplete) |
| `/abort` | Stop the current running session |
| `/add-project <project>` | Create channels for an existing OpenCode project |
| `/create-new-project <name>` | Create a new project folder and start a session |
| `/new-worktree <name>` | Create a git worktree and start a session |
| `/merge-worktree` | Merge worktree branch into default branch |
| `/model` | Change the AI model for this channel or session |
| `/agent` | Change the agent for this channel or session |
| `/share` | Generate a public URL to share the current session |
| `/fork` | Fork the session from a previous message |
| `/queue <message>` | Queue a message to send after current response finishes |
| `/clear-queue` | Clear all queued messages in this thread |
| `/undo` | Undo the last assistant message (revert file changes) |
| `/redo` | Redo the last undone message |
| `/screenshare` | Share your screen via VNC tunnel (auto-stops after 1h) |
| `/screenshare-stop` | Stop screen sharing |
| `/upgrade-and-restart` | Upgrade kimaki to latest and restart the bot |

Kimaki also registers project-specific slash commands from OpenCode: commands become `/name-cmd`, skills become `/name-skill`, and MCP prompts become `/name-cmd`.

### CLI

```bash
# Start the bot (interactive setup on first run)
npx -y kimaki@latest

# Add a project directory as a Discord channel
npx -y kimaki project add [directory]

# Start a session programmatically
npx -y kimaki send --channel <channel-id> --prompt "your prompt"

# Upgrade kimaki and restart
npx -y kimaki upgrade
```

See [CI & Automation docs](docs/ci-automation.md) for the full `send` command reference, GitHub Actions examples, and scheduled tasks.

## Access Control

Kimaki checks Discord permissions before processing any message. Users need **one** of:

- **Server Owner**
- **Manage Server** permission
- **Administrator** permission
- **"Kimaki" role** — create a role with this name (case-insensitive) and assign it to trusted users

The "Kimaki" role is the recommended approach for team access. Messages from users without any of these are ignored.

**Blocking access** — Create a role named **"no-kimaki"** (case-insensitive) to block specific users, even server owners. Useful for preventing accidental bot triggers in shared servers.

**Multi-agent orchestration** — Other Discord bots are ignored by default. Assign the "Kimaki" role to another bot to let it trigger Kimaki sessions.

## Model & Agent Configuration

Set the AI model in your project's `opencode.json`:

```json
{
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

Format: `provider/model-name`. Examples: `anthropic/claude-opus-4-20250514`, `openai/gpt-4o`, `google/gemini-2.5-pro`.

Or use `/model` and `/agent` slash commands to change settings per channel or session.

## Best Practices

**Create a dedicated Discord server for your agents.** This keeps coding sessions separate from other servers and gives you full control over permissions.

**Use the "Kimaki" role for team access.** Assign it to users who should be able to trigger sessions.

**Send long prompts as file attachments.** Discord has character limits. Tap the plus icon and use "Send message as file" for longer prompts. Kimaki reads file attachments as your message.

## Advanced Topics

- [**Advanced Setup**](docs/advanced-setup.md) — Running multiple instances, multiple Discord servers, architecture details
- [**CI & Automation**](docs/ci-automation.md) — Programmatic sessions, GitHub Actions, scheduled tasks, per-session permissions
- [**Screen Sharing**](docs/screen-sharing.md) — Share your screen via browser link (macOS & Linux setup)
- [**Internals**](docs/internals.md) — How Kimaki works under the hood (SQLite, lock port, channel metadata, voice processing)
