<div align='center' class='hidden'>
    <br/>
    <br/>
    <h3>kimaki</h3>
    <p>A collaborative agent orchestrator, inside Discord</p>
    <br/>
    <br/>
</div>

Kimaki is a **collaborative agent orchestrator** that lets you drive every feature of [OpenCode](https://opencode.ai) from Discord. Each Discord **channel is a project**, each **thread is a coding session**. Send a message, an AI agent edits code on your machine.

You can try the bot in the [Kimaki Discord Server](https://discord.gg/qz3hapKcMM) to see what it can do.

## Quick Start

```bash
npx -y kimaki@latest
```

The CLI walks you through everything. Setup takes about 1 minute: you install the Kimaki bot to your Discord server with one click, and Kimaki opens an onboarding thread. There the agent asks which projects you want and creates a channel for each one.

Kimaki needs **OpenCode 2**. If no OpenCode is installed, Kimaki installs it for you with `curl -fsSL https://opencode.ai/v2/install | bash`. If you have OpenCode 1, install OpenCode 2 first with the same command.

## What is Kimaki?

Kimaki turns Discord into the control surface for your coding agents. It connects to [OpenCode](https://opencode.ai), a coding agent similar to Claude Code, and maps your work onto Discord's natural structure:

- **Channels are projects.** Each channel is linked to a project directory on your machine.
- **Threads are sessions.** Every message you send starts a thread that maps to one OpenCode session.

This separation is the whole point. Other Discord/iMessage agent tools cram **everything into a single channel**, so sessions pile on top of each other with no clean way to partition them. Kimaki splits **projects into channels** and **sessions into threads**, so each piece of work has its own place. Switch projects by switching channels. Switch tasks by switching threads. Search, resume, and fork any of them later.

```diagram
                            ┌──────────────────────────────────────────────────┐
   Discord server           │  Your machine                                    │
  ┌──────────────────┐      │                                                  │
  │ #web-app ────────┼──────┼──▶ /code/web-app   ──▶ OpenCode session (thread) │
  │ #api ────────────┼──────┼──▶ /code/api       ──▶ OpenCode session (thread) │
  │ #docs ───────────┼──────┼──▶ /code/docs      ──▶ OpenCode session (thread) │
  └──────────────────┘      │        ▲                                         │
        │ thread = session  │        │  reads, edits, runs commands            │
        ▼                   │        ▼  in the project directory               │
     agent replies  ◀───────┼──── AI agent (any model, your subscriptions)     │
  └──────────────────┘      └──────────────────────────────────────────────────┘
```

Think of it as texting your codebase: you describe what you want, the agent does it, and the conversation lives in a thread you can return to.

## Battle tested every day

I'm Tommy, the creator of Kimaki. I do **all of my development** through it: every project, every session, straight from Discord. I built Kimaki because I wanted one place to start agents, watch them work, jump between projects, and pick things back up from my phone. It is the tool I actually use every day.

## All your models, including subscriptions

Kimaki gives you access to **every model OpenCode supports**: Anthropic, OpenAI, Google, and more. The best part: you can use your existing **Claude Pro/Max** and **ChatGPT/Codex** subscriptions instead of paying per token.

Run `/login`, pick a provider, choose OAuth, and authenticate with your subscription. Logins are stored by OpenCode, so the same accounts work in Discord and in the OpenCode TUI. Kimaki adds the Claude Pro/Max login to OpenCode with a small plugin.

See [Models & Subscriptions](https://kimaki.dev/docs/getting-started/subscriptions) and [Model & Agent Switching](https://kimaki.dev/docs/getting-started/model-switching).

## Core Features

Kimaki adds a layer of orchestration features on top of OpenCode. The ones worth knowing first:

- **[Scheduled tasks](https://kimaki.dev/docs/features/scheduled-tasks)**: run the bot on a schedule (cron or a future time). For example, every morning read your inbox with a CLI like [Zele](https://github.com/remorses/zele) and post an email digest thread; then reply to mark some read or unsubscribe.
- **[The queue](https://kimaki.dev/docs/features/queue)**: queue a message to send when the current run finishes. Great for "review this when you're done" or "commit at the end". End any message with `. queue` and even edit it later to update the queued text.
- **[btw](https://kimaki.dev/docs/features/btw)**: fork the current context into a new thread to ask a clarifying question in parallel while the agent keeps working. End a message with `. btw` or run `/btw`.
- **[Worktrees](https://kimaki.dev/docs/features/worktrees)**: `/new-worktree` starts a session in an isolated Git worktree so it never touches your main checkout. In a thread it forks the current context. `/merge-worktree` merges the commits into a local branch with rebase or squash.
- **[Diff viewer](https://kimaki.dev/docs/features/diff-viewer)**: `/diff` generates a shareable URL to review changes in a real diff viewer from your phone or browser.
- **[Voice messages](https://kimaki.dev/docs/features/voice)**: record a voice note; Kimaki transcribes it using your project's file tree for accuracy.
- **[Images](https://kimaki.dev/docs/features/images)**: attach images and files to your message. The agent can upload screenshots and other files to the thread.
- **[OpenCode commands](https://kimaki.dev/docs/features/opencode-commands)**: your OpenCode commands and skills become Discord slash commands.
- **[Shell commands](https://kimaki.dev/docs/features/shell-commands)**: prefix any message with `!` to run a shell command in the session folder.
- **[Tunnels](https://kimaki.dev/docs/remote-access/tunnels)**: expose a local dev server to a public URL so you can view it on your phone or another machine.
- **[Quick agent switching](https://kimaki.dev/docs/getting-started/model-switching)**: instantly change model or system prompt with a `/<name>-agent` command.
- **[Same sessions in the OpenCode TUI](https://kimaki.dev/docs/remote-access/opencode-server)**: Kimaki uses your OpenCode 2 background service, so every Kimaki session also opens in the OpenCode TUI. `/session-id` prints the command.

## How messages reach a session

A message you send during an active run **interrupts** it. Kimaki cancels pending questions and permission prompts, stops the current run, and sends your message, so the agent picks up your new input right away. To wait for the run to finish instead, end the message with `. queue` or use `/queue`. See [Message Handling](https://kimaki.dev/docs/core-concepts/message-handling).

## Setup

Run the CLI and follow the interactive prompts:

```bash
npx -y kimaki@latest
```

The setup wizard gives you two options:

- **Gateway mode (default)**: uses Kimaki's pre-built Discord bot. No Discord Developer Portal setup needed. Click one install link, authorize the bot in your server, and you're running. Recommended.
- **Self-hosted mode**: create your own Discord bot at [discord.com/developers](https://discord.com/developers/applications). Takes 5-10 minutes. Useful if you want full control over the bot identity.

Both modes work identically after setup. Keep the CLI running; it's the bridge between Discord and your machine.

Agents installing Kimaki on a laptop or VPS should follow [Set up Kimaki from an agent](https://kimaki.dev/docs/guides/agent-machine-setup) instead of cloning this repo.

## Commands

Kimaki ships a full set of slash commands and a CLI. The most common slash commands:

| Command | Description |
|---|---|
| `/resume <session>` | Resume a previous session (with autocomplete) |
| `/abort` | Stop the current running session |
| `/model` | Change the AI model for this channel or session |
| `/agent` | Change the agent for this channel or session |
| `/login` | Authenticate a provider (OAuth subscription or API key) |
| `/queue <message>` | Queue a message to send after the current response finishes |
| `/btw <prompt>` | Fork context into a new thread to ask a side question |
| `/new-worktree <name>` | Start a session in an isolated git worktree |
| `/merge-worktree` | Merge this worktree into a local branch |
| `/diff` | Generate a shareable diff URL |
| `/session-id` | Show the session ID and the command to open it in the OpenCode TUI |

See the full [Commands reference](https://kimaki.dev/docs/reference/commands) for every slash command and CLI subcommand.

## Access Control

Kimaki checks Discord permissions before processing any message. Users need **one** of:

- **Server Owner**
- **Manage Server** permission
- **Administrator** permission
- **"Kimaki" role**: create a role with this name (case-insensitive) and assign it to trusted users

The "Kimaki" role is the recommended approach for team access. Messages from users without any of these are ignored.

- **Blocking access**: create a role named **"no-kimaki"** (case-insensitive) to block specific users, even server owners.
- **Other bots**: messages from other Discord bots are ignored. To start sessions from scripts or CI, use `kimaki send`.

## Best Practices

- **Create a dedicated Discord server** for your agents. This keeps coding sessions separate and gives you full control over permissions.
- **Use the "Kimaki" role** for team access.
- **Send long prompts as file attachments.** Tap the plus icon and use "Send message as file" for longer prompts. Kimaki reads file attachments as your message.

## Troubleshooting

If sessions stop responding or fail to start, restart the OpenCode service with `opencode2 service restart`. Kimaki reconnects by itself.

If the issue is with the bot itself (messages not picked up, threads not created), run `kimaki restart`. To update Kimaki, install the latest version with `npm i -g kimaki@latest`, then run `kimaki restart`. Run `kimaki logs` to find the log file.

See the full [Troubleshooting guide](https://kimaki.dev/docs/guides/troubleshooting).

## Advanced Topics

- [**Channels & Threads**](https://kimaki.dev/docs/core-concepts/channels-threads): the orchestration model in depth
- [**Models & Subscriptions**](https://kimaki.dev/docs/getting-started/subscriptions): use your Claude and Codex subscriptions
- [**CI & Automation**](https://kimaki.dev/docs/guides/ci-automation): programmatic sessions, GitHub Actions, per-session permissions
- [**Scheduled Tasks**](https://kimaki.dev/docs/features/scheduled-tasks): cron and one-time tasks, email digests
- [**Advanced Setup**](https://kimaki.dev/docs/guides/advanced-setup): multiple instances, multiple Discord servers
- [**Docker**](https://kimaki.dev/docs/guides/docker): run Kimaki on a VPS
- [**Internals**](https://kimaki.dev/docs/reference/internals): how Kimaki works under the hood
