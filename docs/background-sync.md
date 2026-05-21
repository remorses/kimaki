---
title: Background Sync
description: Automatically mirror OpenCode sessions started outside Kimaki into Discord threads.
---

# Background Sync

Kimaki runs a background sync loop that mirrors **OpenCode sessions started outside of Discord** into Discord threads. If you start a session from the OpenCode CLI, TUI, or any other client, it automatically appears as a thread in the matching project channel.

```
  Your terminal                              Discord
 ┌────────────────────────────┐             ┌────────────────────────────────────────────┐
 │                            │             │  #my-project                               │
 │  $ opencode                │             │                                            │
 │  > fix the auth bug        │────────────►│  └─ Sync: fix the auth bug                 │
 │    ...model working...     │             │       ⬥ The auth token was expired...      │
 │  > now add tests           │────────────►│       » user: now add tests                │
 │                            │             │       ⬥ I added tests for the auth...      │
 └────────────────────────────┘             └────────────────────────────────────────────┘
```

Sync is **enabled by default**, polls every 5 seconds, is lightweight when idle, and only syncs sessions created after the bot started.

## Use cases

- **Resume sessions from your phone.** Start a coding session on your desktop with the OpenCode CLI. Leave your desk. The session appears in Discord, so you can follow progress, send follow-up messages, or queue commands from your phone.
- **Search past sessions.** Discord's search makes it easy to find sessions across all your projects. Every synced session is a thread with full message history, searchable by keyword, date, or channel.
- **Team collaboration.** When someone on your team starts a session in their terminal, it shows up in the shared Discord channel. Others can see what's happening, jump into the thread, or continue the work without needing access to the original machine.

## How it works

The sync loop checks all registered project directories every 5 seconds. For each directory, it:

1. Lists recent sessions from the OpenCode server
2. Skips sessions already managed by Discord (Kimaki-originated sessions have a `<discord-user />` tag in their messages)
3. Creates a new thread (prefixed with "Sync:") or reuses an existing one for each external session
4. Sends any new messages that haven't been synced yet, respecting your channel's verbosity setting
5. Shows a typing indicator for sessions that are currently busy

**Seamless handoff.** If you start a session in the CLI and then continue it from Discord, the sync loop detects the switch and stops mirroring. If you go back to the CLI, sync picks it up again. No manual toggling; the latest user message determines ownership.

**One server for everything.** Kimaki runs a single shared OpenCode server process for all projects. The sync loop reuses this same server, so there's no extra overhead.

## Disabling sync

If you don't need background sync, disable it with:

```bash
kimaki --disable-sync
```

Kimaki still works normally for Discord-originated sessions; only the external session mirroring is turned off.
