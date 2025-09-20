# Claude Sandbox Discord Bot

A Discord bot that turns messages in a designated channel into live Claude Code sessions, executed inside an isolated Vercel Sandbox, and streams the assistant’s output back to Discord threads. Built with Bun.

- Runtime: Bun
- LLM: Anthropic Claude via `@anthropic-ai/claude-code` CLI
- Isolation: `@vercel/sandbox`
- Chat surface: Discord threads

## Features

- Thread-per-conversation: New message in your configured channel creates a thread and a Claude session; replies in that thread continue the same session.
- Streaming to Discord: System, assistant, user, and result events are rendered as Discord embeds, including tool use and images.
- Sandboxed execution: Claude Code runs inside a Vercel Sandbox for isolation.

## Prerequisites

- Bun installed (`bun --version`).
- A Discord application with a bot user and the Message Content intent enabled.
- An Anthropic API key with access to Claude Code.
- Permissions in your target Discord channel to create and post in threads.

## Quick start

1. Clone and install

```bash
git clone https://github.com/your-org/claude-sandbox-bot.git
cd claude-sandbox-bot
bun install
```

2. Configure environment

Create a `.env` file (or export in your shell) with the following (Bun loads `.env` automatically):

```bash
# Required
DISCORD_BOT_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx.xxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DISCORD_CHANNEL_ID=123456789012345678   # Channel where new messages start sessions
ANTHROPIC_API_KEY=sk-ant-...            # Your Anthropic API key
```

3. Run the bot

```bash
bun run index.ts
# or
bun run dev
```

The bot will log in and wait for messages. Post in the configured channel to start a new thread + Claude session. Reply inside that thread to continue the same session.

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
- `ANTHROPIC_API_KEY` (required): Used inside the sandbox to authorize Claude Code.

Runtime notes:

- The bot uses Bun to run locally. Use `bun install` and `bun run index.ts`.
- Inside the Vercel Sandbox, the app installs `@anthropic-ai/claude-code` globally and runs the `claude` CLI with streaming JSON output.
- If sandbox creation requires authentication in your environment, ensure any necessary credentials are configured before running.

## How it works

- `src/discordBot.ts`
  - Listens for messages. If a message arrives in `DISCORD_CHANNEL_ID`, it creates a thread, sends a “Starting Claude session…” notice, and kicks off a Claude Code session via the sandbox.
  - Messages in an existing managed thread continue the same session.
  - Streams model output back to Discord using embeds and attachments.
- `src/sandbox.ts`
  - Creates (or resumes) a `@vercel/sandbox` environment.
  - Installs the `claude` CLI and runs it with:
    - `--output-format stream-json`
    - `--verbose`
    - `--dangerously-skip-permissions` (see security note below)
    - appends a small system prompt and passes your user prompt
  - Emits structured events (system, assistant, user, result) that get forwarded to Discord.
- `src/utils.ts`
  - Translates Claude message content into Discord embeds and file attachments.
- `index.ts`
  - Reads env vars and starts the Discord bot.

Security note: the sandbox invocation uses `--dangerously-skip-permissions` for convenience. Review and adjust for production.

## Project structure

```
claude-sandbox-bot/
  index.ts                 # Entry point (Bun)
  src/
    discordBot.ts          # Discord wiring & session/thread handling
    sandbox.ts             # Vercel Sandbox + Claude CLI bridge
    utils.ts               # Embed/attachment rendering helpers
  package.json             # Bun scripts and deps
  tsconfig.json
  LICENSE
```

## Troubleshooting

- Bot doesn’t respond:
  - Confirm `DISCORD_BOT_TOKEN` and that the bot is in the server.
  - Ensure the bot has permission to read and post in the target channel.
  - Check that Message Content Intent is enabled in the Developer Portal.
- Thread not created or errors like “Missing Access”:
  - The bot needs “Create Public Threads” and “Send Messages in Threads” in that channel.
- Error: `ANTHROPIC_API_KEY is not set`:
  - Provide your Anthropic key in environment; the key is passed into the sandbox.
- Sandbox creation fails:
  - Ensure your network allows the sandbox to fetch from GitHub and install dependencies. If your setup requires credentials for sandbox creation, configure them accordingly.

## License

MIT © 2025 Rhys Sullivan. See [LICENSE](./LICENSE).
