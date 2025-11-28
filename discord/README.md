# Kimaki Discord Bot

A Discord bot that integrates OpenCode coding sessions with Discord channels and voice.

## Installation

```bash
npm install -g kimaki
```

## Setup

Run the interactive setup:

```bash
kimaki
```

This will guide you through:
1. Creating a Discord application at https://discord.com/developers/applications
2. Getting your bot token
3. Installing the bot to your Discord server
4. Creating channels for your OpenCode projects

## Commands

### Start the bot

```bash
kimaki
```

### Send a session to Discord

Send an OpenCode session to Discord from the CLI:

```bash
kimaki send-to-discord <session-id>
```

Options:
- `-d, --directory <dir>` - Project directory (defaults to current working directory)

### OpenCode Integration

To use the `/send-to-kimaki-discord` command in OpenCode:

```bash
npx kimaki install-plugin
```

Then use `/send-to-kimaki-discord` in OpenCode to send the current session to Discord.

## Discord Slash Commands

Once the bot is running, you can use these commands in Discord:

- `/session <prompt>` - Start a new OpenCode session
- `/resume <session>` - Resume an existing session
- `/add-project <project>` - Add a new project to Discord
- `/accept` - Accept a permission request
- `/accept-always` - Accept and auto-approve similar requests
- `/reject` - Reject a permission request

## Voice Support

Join a voice channel that has an associated project directory, and the bot will join with Jarvis-like voice interaction powered by Gemini.

Requires a Gemini API key (prompted during setup).
