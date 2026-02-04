<div align='center'>
    <br/>
    <br/>
    <h3>kimaki</h3>
    <p>Iron Man's Jarvis for coding agents, inside Discord</p>
    <br/>
    <br/>
</div>

Kimaki is a Discord bot that lets you control [OpenCode](https://opencode.ai) coding sessions from Discord. Send a message in a Discord channel → an AI agent edits code on your machine.

## Quick Start

```bash
npx -y kimaki@latest
```

That's it. The CLI guides you through everything.

## What is Kimaki?

Kimaki connects Discord to OpenCode, a coding agent similar to Claude Code. Each Discord channel is linked to a project directory on your machine. When you send a message in that channel, Kimaki starts an OpenCode session that can:

- Read and edit files
- Run terminal commands
- Search your codebase
- Use any tools you've configured

Think of it as texting your codebase. You describe what you want, the AI does it.

## Installation & Setup

Run the CLI and follow the interactive prompts:

```bash
npx -y kimaki@latest
```

The setup wizard will:

1. **Create a Discord Bot** - Walk you through creating a bot at [discord.com/developers](https://discord.com/developers/applications)
2. **Configure Bot Settings** - Enable required intents (Message Content, Server Members)
3. **Install to Your Server** - Generate an invite link with proper permissions
4. **Select Projects** - Choose which OpenCode projects to add as Discord channels

Keep the CLI running. It's the bridge between Discord and your machine.

## Architecture: One Bot Per Machine

**Each Discord bot you create is tied to one machine.** This is by design.

When you run `kimaki` on a computer, it spawns OpenCode servers for projects on that machine. The bot can only access directories on the machine where it's running.

To control multiple machines:

1. Create a separate Discord bot for each machine
2. Run `kimaki` on each machine with its own bot token
3. Add all bots to the same Discord server

Each channel shows which bot (machine) it's connected to. You can have channels from different machines in the same server, controlled by different bots.

## Running Multiple Instances

By default, Kimaki stores its data in `~/.kimaki`. To run multiple bot instances on the same machine (e.g., for different teams or projects), use the `--data-dir` option:

```bash
# Instance 1 - uses default ~/.kimaki
npx -y kimaki@latest

# Instance 2 - separate data directory
npx -y kimaki@latest --data-dir ~/work-bot

# Instance 3 - another separate instance
npx -y kimaki@latest --data-dir ~/personal-bot
```

Each instance has its own:
- **Database** - Bot credentials, channel mappings, session history
- **Projects directory** - Where `/create-new-project` creates new folders
- **Lock port** - Derived from the data directory path, so instances don't conflict

This lets you run completely isolated bots on the same machine, each with their own Discord app and configuration.

## Multiple Discord Servers

A single Kimaki instance can serve multiple Discord servers. Install the bot in each server using the install URL shown during setup, then add project channels to each server.

### Method 1: Use `/add-project` command

1. Run `npx kimaki` once to set up the bot
2. Install the bot in both servers using the install URL
3. In **Server A**: run `/add-project` and select your project
4. In **Server B**: run `/add-project` and select your project

The `/add-project` command creates channels in whichever server you run it from.

### Method 2: Re-run CLI with `--add-channels`

1. Run `npx kimaki` - set up bot, install in both servers, create channels in first server
2. Run `npx kimaki --add-channels` - select projects for the second server

The setup wizard lets you pick one server at a time.

You can even link the same project to channels in multiple servers - both will point to the same directory on your machine.

## Best Practices

**Create a dedicated Discord server for your agents.** This keeps your coding sessions separate from other servers and gives you full control over permissions.

**Add all your bots to that server.** One server, multiple machines. Each channel is clearly labeled with its project directory.

**Use the "Kimaki" role for team access.** Create a role named "Kimaki" (case-insensitive) and assign it to users who should be able to trigger sessions.

**Send long prompts as file attachments.** Discord has character limits for messages. Tap the plus icon and use "Send message as file" for longer prompts. Kimaki reads file attachments as your message.

## Required Permissions

Only users with these Discord permissions can interact with the bot:

- **Server Owner** - Full access
- **Administrator** - Full access
- **Manage Server** - Full access
- **"Kimaki" role** - Create a role with this name and assign to trusted users

Messages from users without these permissions are ignored.

### Blocking Access with "no-kimaki" Role

Create a role named **"no-kimaki"** (case-insensitive) to block specific users from using the bot, even if they have other permissions like Server Owner or Administrator.

This implements the "four-eyes principle" - it adds friction to prevent accidental usage. Even if you're a server owner, you must remove this role to interact with the bot.

**Use cases:**
- Prevent accidental bot triggers by owners who share servers
- Temporarily disable access for specific users
- Break-glass scenario: removing the role is a deliberate action

## Features

### Text Messages

Send any message in a channel linked to a project. Kimaki creates a thread and starts an OpenCode session.

### File Attachments

Attach images, code files, or any other files to your message. Kimaki includes them in the session context.

### Voice Messages

Record a voice message in Discord. Kimaki transcribes it using Google's Gemini API and processes it as text. The transcription uses your project's file tree for accuracy, recognizing function names and file paths you mention.

Requires a Gemini API key (prompted during setup).

### Session Management

- **Resume sessions** - Continue where you left off
- **Fork sessions** - Branch from any message in the conversation
- **Share sessions** - Generate public URLs to share your session

### Message Queue

Use `/queue <message>` to queue a follow-up message while the AI is still responding. The queued message sends automatically when the current response finishes. If no response is in progress, it sends immediately. Useful for chaining tasks without waiting.

## Commands Reference

### Text Interaction

Just send a message in any channel linked to a project. Kimaki handles the rest.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/session <prompt>` | Start a new session with an initial prompt |
| `/resume <session>` | Resume a previous session (with autocomplete) |
| `/abort` | Stop the current running session |
| `/add-project <project>` | Create channels for an existing OpenCode project |
| `/create-new-project <name>` | Create a new project folder and start a session |
| `/new-worktree <name>` | Create a git worktree and start a session (⬦ prefix) |
| `/merge-worktree` | Merge worktree branch into default branch |
| `/model` | Change the AI model for this channel or session |
| `/agent` | Change the agent for this channel or session |
| `/share` | Generate a public URL to share the current session |
| `/fork` | Fork the session from a previous message |
| `/queue <message>` | Queue a message to send after current response finishes |
| `/clear-queue` | Clear all queued messages in this thread |
| `/undo` | Undo the last assistant message (revert file changes) |
| `/redo` | Redo the last undone message |

### CLI Commands

```bash
# Start the bot (interactive setup on first run)
npx -y kimaki@latest

# Upload files to a Discord thread
npx -y kimaki upload-to-discord --session <session-id> <file1> [file2...]

# Start a session programmatically (useful for CI/automation)
npx -y kimaki send --channel <channel-id> --prompt "your prompt"

# Start a session in an isolated git worktree
npx -y kimaki send --channel <channel-id> --prompt "your prompt" --worktree feature-name

# Send notification without starting AI session (reply to start session later)
npx -y kimaki send --channel <channel-id> --prompt "User cancelled subscription" --notify-only

# Create Discord channels for a project directory (without starting a session)
npx -y kimaki add-project [directory]
```

## Add Project Channels

Create Discord channels for a project directory without starting a session. Useful for automation and scripting.

```bash
# Add current directory as a project
npx -y kimaki add-project

# Add a specific directory
npx -y kimaki add-project /path/to/project

# Specify guild when bot is in multiple servers
npx -y kimaki add-project ./myproject --guild 123456789

# In CI with env var for bot token
KIMAKI_BOT_TOKEN=xxx npx -y kimaki add-project --app-id 987654321
```

### Options

| Option | Description |
|--------|-------------|
| `[directory]` | Project directory path (defaults to current directory) |
| `-g, --guild <guildId>` | Discord guild/server ID (auto-detects if bot is in only one server) |
| `-a, --app-id <appId>` | Bot application ID (reads from database if available) |

## Programmatically Start Sessions

You can start Kimaki sessions from CI pipelines, cron jobs, or any automation. The `send` command creates a Discord thread, and the running bot on your machine picks it up.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KIMAKI_BOT_TOKEN` | Yes (in CI) | Discord bot token |

### CLI Options

```bash
npx -y kimaki send \
  --channel <channel-id>  # Required: Discord channel ID
  --prompt <prompt>       # Required: Message content
  --name <name>           # Optional: Thread name (defaults to prompt preview)
  --app-id <app-id>       # Optional: Bot application ID for validation
  --notify-only           # Optional: Create notification thread without starting AI session
  --worktree <name>       # Optional: Create git worktree for isolated session
```

### Example: GitHub Actions on New Issues

This workflow starts a Kimaki session whenever a new issue is opened:

```yaml
# .github/workflows/investigate-issues.yml
name: Investigate New Issues

on:
  issues:
    types: [opened]

jobs:
  investigate:
    runs-on: ubuntu-latest
    steps:
      - name: Start Kimaki Session
        env:
          KIMAKI_BOT_TOKEN: ${{ secrets.KIMAKI_BOT_TOKEN }}
        run: |
          npx -y kimaki send \
            --channel "1234567890123456789" \
            --prompt "Investigate issue ${{ github.event.issue.html_url }} using gh cli. Try fixing it in a new worktree ./${{ github.event.issue.number }}" \
            --name "Issue #${{ github.event.issue.number }}"
```

**Setup:**
1. Add `KIMAKI_BOT_TOKEN` to your repository secrets (Settings → Secrets → Actions)
2. Replace `1234567890123456789` with your Discord channel ID (right-click channel → Copy Channel ID)
3. Make sure the Kimaki bot is running on your machine

### How It Works

1. **CI runs `send`** → Creates a Discord thread with your prompt
2. **Running bot detects thread** → Automatically starts a session
3. **Bot starts OpenCode session** → Uses the prompt from the thread
4. **AI investigates** → Runs on your machine with full codebase access

Use `--notify-only` for notifications that don't need immediate AI response (e.g., subscription events). Reply to the thread later to start a session with the notification as context.

## How It Works

**SQLite Database** - Kimaki stores state in `<data-dir>/discord-sessions.db` (default: `~/.kimaki/discord-sessions.db`). This maps Discord threads to OpenCode sessions, channels to directories, and stores your bot credentials. Use `--data-dir` to change the location.

**OpenCode Servers** - When you message a channel, Kimaki spawns (or reuses) an OpenCode server for that project directory. The server handles the actual AI coding session.

**Channel Metadata** - Each channel's topic contains XML metadata linking it to a directory and bot:
```xml
<kimaki><directory>/path/to/project</directory><app>bot_id</app></kimaki>
```

**Voice Processing** - Voice features run in a worker thread. Audio flows: Discord Opus → Decoder → Downsample (48kHz→16kHz) → Gemini API → Response → Upsample → Opus → Discord.

**Graceful Restart** - Send `SIGUSR2` to restart the bot with new code without losing connections.

## Model & Agent Configuration

Set the AI model in your project's `opencode.json`:

```json
{
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

Format: `provider/model-name`

**Examples:**
- `anthropic/claude-sonnet-4-20250514` - Claude Sonnet 4
- `anthropic/claude-opus-4-20250514` - Claude Opus 4
- `openai/gpt-4o` - GPT-4o
- `google/gemini-2.5-pro` - Gemini 2.5 Pro

Or use these Discord commands to change settings per channel/session:
- `/model` - Select a different AI model
- `/agent` - Select a different agent (if you have multiple agents configured in your project)
