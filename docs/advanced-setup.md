---
title: Advanced Setup
description: Running multiple Kimaki instances, multiple Discord servers, and architecture details.
---

# Advanced Setup

## Architecture: One Bot Per Machine

**Each bot instance is tied to one machine.** This is by design.

When you run `kimaki` on a computer, it spawns OpenCode servers for projects on that machine. The bot can only access directories on the machine where it's running.

To control multiple machines:

1. Create a separate Discord bot for each machine (or use gateway mode on each)
2. Run `kimaki` on each machine
3. Add all bots to the same Discord server

Each channel shows which bot (machine) it's connected to. You can have channels from different machines in the same server, controlled by different bots.

## Running Multiple Instances

By default, Kimaki stores its data in `~/.kimaki`. To run multiple bot instances on the same machine (e.g., for different teams or projects), use a separate `--data-dir` and optionally set `KIMAKI_LOCK_PORT` explicitly:

```bash
# Instance 1 - uses default ~/.kimaki
npx -y kimaki@latest

# Instance 2 - separate data directory + explicit lock port
KIMAKI_LOCK_PORT=31001 npx -y kimaki@latest --data-dir ~/work-bot

# Instance 3 - another separate instance
KIMAKI_LOCK_PORT=31002 npx -y kimaki@latest --data-dir ~/personal-bot
```

Each instance has its own:

- **Database** — Bot credentials, channel mappings, session history
- **Projects directory** — Where `/create-new-project` creates new folders
- **Lock port** — Derived from the data directory path by default; override with `KIMAKI_LOCK_PORT` when you need a specific port

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

1. Run `npx kimaki` — set up bot, install in both servers, create channels in first server
2. Run `npx kimaki --add-channels` — select projects for the second server

The setup wizard lets you pick one server at a time.

You can link the same project to channels in multiple servers — both will point to the same directory on your machine.
