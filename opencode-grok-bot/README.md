# @kimaki/plugin-grok-bot

Use your **Grok Bot** bots as OpenCode V2 models. Every bot and group of your account is a model, and a session chats with it like the Grok Bot app does.

```jsonc
// opencode.json
{
  "plugins": [{ "package": "@kimaki/plugin-grok-bot" }],
  "model": "grok-bot/ghosthand-x-marketing",
}
```

Then run `/connect`, pick **Grok Bot**, then **Grok Bot account (browser sign-in)**, and approve with the Cursor account of your Grok Bot.

## How it works

Grok Bot is a **remote agent**, not a plain model. It runs on its own cloud computer with its own tools, skills, memory and chat history. Each OpenCode turn sends only the new user text and streams back the bot's reply.

```
OpenCode turn ──▶ new user text only ──▶ sendPrompt ──▶ Grok Bot (cloud computer, own tools)
OpenCode UI   ◀── text, reasoning, tool activity, cards as text ◀── transcript + roster polling
```

- **Model IDs** are bot names in kebab case (`grok-bot/qa-engineer`). Two bots with the same name: the newer one gets the first 4 ID characters (`backlinks-5ad0`). A renamed bot keeps its old ID as an alias.
- **New bots**: create them in the Grok Bot app. They show up as models when the plugin lists the bots again: on OpenCode start, on a login change, or after the plugin creates a bot. A model ID that matches no bot, for example one only listed under `providers."grok-bot".models` in `opencode.json`, creates a bot with that name on its first turn.
- **Cards** (questions, approvals, app access) render as text. Reply with an option number, or `approve` / `always` / `deny`, to answer them.

## Limitations

Checked with real turns against a Grok Bot account on OpenCode 2.2.5. Rows marked _(code)_ come from reading the plugin code only.

| OpenCode feature | Reaches the bot? | Details |
| --- | --- | --- |
| System prompt, agent prompt, `AGENTS.md`, instruction entries | **No** | The bot never sees global or project `AGENTS.md`, or entries like Kimaki's system prompt. Put instructions in the bot itself, in the Grok Bot app. |
| Skills | **Only when invoked** | The skill list lives in the system prompt, so the bot never sees it. An invoked skill is inlined into the user message, so its text arrives, but the bot cannot open the skill's files: they are on your machine. |
| Tools and MCP servers | **No** _(code)_ | OpenCode tools are never offered. The bot uses its own tools on its own computer, so files it edits are there, not in your project. |
| Tool calls shown in OpenCode | **Partly** | Only the bot's activity name and a short detail show, as finished tool calls. No inputs or outputs. |
| Permissions | **No** | OpenCode permission rules do not apply. Bot approvals arrive as text cards. Forms, secrets and drafts must be done in the Grok Bot app. |
| Subagents | **No** _(code)_ | The bot cannot start OpenCode subagents. A subagent that uses a `grok-bot` model writes to the same bot chat as every other session on that model. |
| History | **Bot's own** | One bot is one chat, shared by every OpenCode session on that model: a new session sees what earlier sessions said. Revert, fork and edits in OpenCode do not change the bot's history _(code)_. Switching a session to a `grok-bot` model mid-conversation does not send the earlier messages _(code)_. |
| Synthetic messages | **Yes** | Synthetic notes added before a prompt are sent with it as plain text. |
| Compaction | **Local** | No request reaches the bot and the summary is a fixed line. The first turn after a compaction sends OpenCode's `<conversation-checkpoint>` recap of the last turn to the bot. Automatic compaction does not happen: the context window is 1M and usage is 0. |
| Attachments | **Text files only** | Text files are inlined into the message with their name. Images are replaced by OpenCode with "this model does not support image input". Other binary files are not sent _(code)_. |
| Cancel | **Yes** | Interrupting the session stops the bot's run; the bot was idle about 1s later. |
| Retry | **No** | Failed turns are never retried, so a prompt is never sent twice. |
| Title | **Local** | The first line of the first user message. |
| Usage and cost | **No** | Tokens and cost are always 0. |
| Multiple accounts | **Yes** _(code)_ | Connect several accounts in `/connect`. Only the active account's bots are listed as models. |

Other limits:

- **No official API.** The plugin uses the private gateway of the Grok Bot desktop app. A Grok Bot update can break it.
- **Desktop app login** (the second `/connect` method) is macOS only and was not tested end to end.
- **Slow first turn** _(code)_: a sleeping cloud computer is woken first, which can take up to 2 minutes.
- **Silent bots** _(code)_: when the bot is idle but never reports the end of its turn, the turn ends 2 minutes after it started.
