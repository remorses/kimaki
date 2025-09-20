# OpenCode Discord Bot

A Discord bot that turns messages in a designated channel into live OpenCode sessions and streams the assistant's output back to Discord threads. Built with Bun.

- Runtime: Bun
- LLM: Any OpenCode-supported model (Claude, GPT, etc.) via `@opencode-ai/sdk`
- Execution: OpenCode server with isolated tool execution
- Chat surface: Discord threads

## Features

- Thread-per-conversation: New message in your configured channel creates a thread and an OpenCode session; replies in that thread continue the same session.
- Streaming to Discord: System, assistant, user, and result events are rendered as Discord embeds, including tool use.
- Multi-model support: Works with any LLM provider configured in OpenCode (Anthropic, OpenAI, etc.).

## Prerequisites

- Bun installed (`bun --version`).
- OpenCode CLI installed (`opencode` command available).
- A Discord application with a bot user and the Message Content intent enabled.
- API keys for your preferred LLM providers configured in OpenCode.

## Quick start

1. Clone and install

```bash
git clone https://github.com/your-org/opencode-discord-bot.git
cd opencode-discord-bot
bun install
```

2. Configure environment

Create a `.env` file (or export in your shell) with the following (Bun loads `.env` automatically):

```bash
# Required
DISCORD_BOT_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx.xxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DISCORD_CHANNEL_ID=123456789012345678   # Channel where new messages start sessions

# Configure your LLM providers in OpenCode
# Run: opencode config
```

3. Run the bot

```bash
bun run index.ts
# or
bun run dev
```

The bot will log in and wait for messages. Post in the configured channel to start a new thread + OpenCode session. Reply inside that thread to continue the same session.

## Discord setup

- Create a Discord application and add a bot at the Discord Developer Portal.
- Enable the following in the Bot settings:
  - Presence Intent (optional)
  - Server Members Intent (optional)
  - Message Content Intent (required)
- Invite the bot to your server with permissions to:
  - Read Messages/View Channels
  - Send Messages
  - Create Public Threads
  - Send Messages in Threads
- Get the channel ID where you want to start sessions:
  - In Discord, enable Developer Mode → right-click the channel → Copy ID
  - Set that value as `DISCORD_CHANNEL_ID`

## Configuration

Environment variables read by the app (see `index.ts`):

- `DISCORD_BOT_TOKEN` (required): Your bot token.
- `DISCORD_CHANNEL_ID` (required): Channel where new messages create a thread + session.

OpenCode configuration:

- The bot uses the local OpenCode installation and configuration.
- Configure your LLM providers by running `opencode config` before starting the bot.
- The bot will automatically start an OpenCode server on an available port.

## How it works

- `src/discordBot.ts`
  - Listens for messages. If a message arrives in `DISCORD_CHANNEL_ID`, it creates a thread, sends a "Starting OpenCode session…" notice, and kicks off an OpenCode session.
  - Messages in an existing managed thread continue the same session.
  - Streams model output back to Discord using embeds.
- `src/opencode.ts`
  - Starts a local OpenCode server on an available port.
  - Creates (or resumes) OpenCode sessions using the SDK.
  - Subscribes to server-sent events to stream responses.
  - Emits structured events (system, assistant, user, result) that get forwarded to Discord.
- `src/utils.ts`
  - Translates OpenCode message parts into Discord embeds.
  - Handles text, tool usage, reasoning, and file parts.
- `index.ts`
  - Reads env vars and starts the Discord bot.

## Project structure

```
opencode-discord-bot/
  index.ts                 # Entry point (Bun)
  src/
    discordBot.ts          # Discord wiring & session/thread handling
    opencode.ts            # OpenCode server + SDK bridge
    utils.ts               # Embed rendering helpers
  package.json             # Bun scripts and deps
  tsconfig.json
  LICENSE
```

## Troubleshooting

- Bot doesn't respond:
  - Confirm `DISCORD_BOT_TOKEN` and that the bot is in the server.
  - Ensure the bot has permission to read and post in the target channel.
  - Check that Message Content Intent is enabled in the Developer Portal.
  - Make sure OpenCode CLI is installed: `opencode --version`
- Thread not created or errors like "Missing Access":
  - The bot needs "Create Public Threads" and "Send Messages in Threads" in that channel.
- Error: `opencode` command not found:
  - Install OpenCode CLI following instructions at https://opencode.ai
- OpenCode server fails to start:
  - Check that no other process is using the ports OpenCode needs.
  - Ensure your OpenCode configuration is valid: `opencode config`

## Differences from Claude Sandbox version

This version uses OpenCode instead of Claude Code SDK:
- No need for `ANTHROPIC_API_KEY` in environment variables
- Uses local OpenCode configuration for LLM providers
- Supports multiple LLM providers (not just Claude)
- Runs OpenCode server locally instead of in a Vercel Sandbox
- Tool execution happens through OpenCode's built-in tools

## License

MIT © 2025. See [LICENSE](./LICENSE).