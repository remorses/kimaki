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
2. **Configure Bot Settings** - Enable required intents (Message Content, Server Members, Voice States)
3. **Install to Your Server** - Generate an invite link with proper permissions
4. **Select Projects** - Choose which OpenCode projects to add as Discord channels
5. **Voice Setup (Optional)** - Request a Google Gemini API key for voice features

Keep the CLI running. It's the bridge between Discord and your machine.

## Architecture: One Bot Per Machine

**Each Discord bot you create is tied to one machine.** This is by design.

When you run `kimaki` on a computer, it spawns OpenCode servers for projects on that machine. The bot can only access directories on the machine where it's running.

To control multiple machines:

1. Create a separate Discord bot for each machine
2. Run `kimaki` on each machine with its own bot token
3. Add all bots to the same Discord server

Each channel shows which bot (machine) it's connected to. You can have channels from different machines in the same server, controlled by different bots.

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

## Features

### Text Messages

Send any message in a channel linked to a project. Kimaki creates a thread and starts an OpenCode session.

### File Attachments

Attach images, code files, or any other files to your message. Kimaki includes them in the session context.

### Voice Messages

Record a voice message in Discord. Kimaki transcribes it using Google's Gemini API and processes it as text. The transcription uses your project's file tree for accuracy, recognizing function names and file paths you mention.

Requires a Gemini API key (prompted during setup).

### Voice Channels

Join a voice channel linked to a project for real-time voice interaction. Talk naturally, and Kimaki responds with voice—like having Jarvis for your codebase.

Uses Gemini's native audio model for low-latency conversation.

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
| `/accept` | Accept a permission request (file edit, command execution) |
| `/accept-always` | Accept and auto-approve similar future requests |
| `/reject` | Reject a permission request |
| `/model` | Change the AI model for this channel |
| `/share` | Generate a public URL to share the current session |
| `/fork` | Fork the session from a previous message |
| `/queue <message>` | Queue a message to send after current response finishes |
| `/clear-queue` | Clear all queued messages in this thread |

### CLI Commands

```bash
# Start the bot (interactive setup on first run)
npx -y kimaki@latest

# Upload files to a Discord thread
npx -y kimaki upload-to-discord --session <session-id> <file1> [file2...]
```

## How It Works

**SQLite Database** - Kimaki stores state in `~/.kimaki/discord-sessions.db`. This maps Discord threads to OpenCode sessions, channels to directories, and stores your bot credentials.

**OpenCode Servers** - When you message a channel, Kimaki spawns (or reuses) an OpenCode server for that project directory. The server handles the actual AI coding session.

**Channel Metadata** - Each channel's topic contains XML metadata linking it to a directory and bot:
```xml
<kimaki><directory>/path/to/project</directory><app>bot_id</app></kimaki>
```

**Voice Processing** - Voice features run in a worker thread. Audio flows: Discord Opus → Decoder → Downsample (48kHz→16kHz) → Gemini API → Response → Upsample → Opus → Discord.

**Graceful Restart** - Send `SIGUSR2` to restart the bot with new code without losing connections.

## Model Configuration

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

Or use the `/model` command in Discord to change models per channel.
