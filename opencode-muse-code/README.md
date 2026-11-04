# @kimaki/plugin-muse-code

Use **Muse Code** (Meta's coding agent) as an OpenCode V2 provider. Muse runs its own agent loop and tools in its OS sandbox on your machine; OpenCode shows its replies and tool calls.

```jsonc
// opencode.json
{
  "plugins": [{ "package": "@kimaki/plugin-muse-code" }],
  "agents": {
    "muse": { "mode": "all", "model": "muse/muse-spark-1.3" },
  },
}
```

Install the `muse` CLI (`curl -fsSL https://dev.meta.ai/install.sh | bash`), then run `/connect`, pick **Muse Code** and one of:

- **Meta account with a Muse Code subscription**: device login, repeat it to add more accounts.
- **Muse Code CLI login**: reuses `muse login`. You still have to pick it once in `/connect`; without a connection the provider stays off and turns fail with `Model unavailable`.

## How it works

Like OpenCode's claude-agent provider, the model loop stays in the vendor binary. The plugin drives `muse serve` over Meta's session protocol (`@muse-code/sdk`).

```
OpenCode turn ──▶ new user text + images ──▶ muse serve (one per account) ──▶ Muse session
                                                │                              │
                                                └─ META_API_KEY or muse login  └─ own tools,
OpenCode UI   ◀── text, reasoning, tool calls (provider-executed) ◀─────────────  sandbox,
                                                                                   history
```

- **Model IDs** come from Muse's `model/list` for the active account: `muse/muse-spark-1.3`, `muse/muse-wonder-1.0`, `muse/muse-spark-1.2`. Variants set the reasoning effort.
- **One OpenCode session is one Muse session.** Only the new user input is sent each turn. The Muse session ID is stored, so a restart or an account switch resumes the same session.
- **Agent settings**: `request.settings.approvalMode` (`allowAll`, `promptUnmatched`, `onRequest`, `denyUnmatched`) and `permissionProfile` go to the Muse session.
- **Plugin options**: `bin`, `provider` (`meta`, `echo`, `local`), `args` (extra `muse serve` flags), `trustWorkspace` (default `true`), `approvalMode`, `permissionProfile`.

## Limitations

Checked with real turns on `muse-spark-1.3` (Muse Code 1.4.14, OpenCode 2.2.5, `muse login` account). Rows marked _(code)_ come from reading the plugin code only.

| OpenCode feature | Reaches Muse? | Details |
| --- | --- | --- |
| System prompt, global `AGENTS.md`, instruction entries | **No** | Muse uses its own system prompt. `~/.config/opencode/AGENTS.md` and entries like Kimaki's system prompt never arrive. |
| Agent prompt | **Once** | The OpenCode agent's own prompt is sent before the first message of a new Muse session, never again _(e2e test with the `echo` provider)_. |
| Project `AGENTS.md` | **Yes, by Muse** | Muse loads it itself (also `CLAUDE.md`, `.agents/AGENTS.md`), up to the `.git` root. This needs `trustWorkspace`, which is on by default. |
| Skills | **Only when invoked** | OpenCode's skill list never arrives. An invoked skill is inlined into the message, so its text arrives. Muse has its own skills instead: built-ins plus `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` and the project's `.agents/skills`. Skills only in `~/.config/opencode/skills` or added by plugins (like `kimaki-debug`) are missing. |
| Tools and MCP servers | **No** | Muse only has its own tools (`bash`, `read_file`, `edit_file`, `web_search`, `subagent_spawn`, ...). Configure MCP servers in `~/.config/muse/settings.json`. |
| Tool calls shown in OpenCode | **Yes** | As finished provider-executed calls with input and output. Output is cut at 20,000 chars _(code)_. |
| Permissions | **Rarely** | Muse's own AI reviewer approved every shell command and network host in the test turns, and none reached OpenCode. Only approvals Muse escalates become OpenCode asks named `muse.<kind>`, like `muse.shell` _(code)_. Muse's question cards are turned off, so it asks in plain text _(code)_. |
| Subagents | **Muse's own** | Muse spawns its own subagents. Each shows as a `subagent` call with its result, and the subagent's tool calls show before it as `subagent.<tool>` (like `subagent.bash`). Muse cannot start OpenCode subagents, but an OpenCode agent can run a Muse agent as its subagent. |
| History | **Muse's own** | Kept across turns in Muse's session store (`~/.local/share/muse/sessions`). Revert, fork and edits in OpenCode do not change it _(code)_. Switching a session to a `muse` model mid-conversation sends the last 20,000 chars of earlier text, without tool calls _(code)_. |
| Synthetic messages | **Yes** | Synthetic notes (like Kimaki's git branch line) are sent with the next prompt as plain text. |
| Compaction | **Local** | No request reaches Muse and the summary is a fixed line. Muse compacts its own history, and it still remembered earlier facts after an OpenCode compaction. Automatic compaction never happens because usage is 0. |
| Attachments | **Text and images** | Text files are inlined and images are sent to Muse. OpenCode drops PDFs with "this model does not support pdf input". Other binary files are replaced by a short note _(code)_. |
| Cancel | **Yes** | Interrupting stopped the turn and killed the running shell command in Muse's sandbox within a few seconds. The next turn worked. |
| Retry | **Only for account errors** | Used-up plans and lost logins are left to OpenCode, so the fallback plugin can switch account. Other failures are never retried, so Muse never runs tools twice _(code)_. |
| Title | **Local** | The first line of the first user message. |
| Usage and cost | **No** | Muse reports no token counts: tokens, cost and context % are always 0. |
| Multiple accounts | **Untested** | Each "Meta account" connection gets its own key and `muse serve`, and an account switch resumes the same Muse session. This is only tested with Muse's `echo` provider. The real device login, and whether its key bills the subscription, are not tested. |

## Sandbox

The sandbox runs **on your machine**, not on a cloud computer. On macOS it is Seatbelt. A real turn showed:

| Check | Result |
| --- | --- |
| Working directory | The OpenCode project folder; hostname is the local Mac. |
| Writes in the project folder | **Allowed.** File edits are real changes to your repo. |
| Writes outside it (for example `~`) | Blocked with `Operation not permitted`. |
| Network, including localhost | Goes through Muse's proxy. Each new host waits a few seconds for Muse's reviewer, so short timeouts fail (`curl -m 5` got no answer). |
| Environment | No `KIMAKI_*` or `OPENCODE_SESSION_ID` variables. |

- **Fixed per process** _(code)_: sandbox flags (`--disable-sandbox`, `--sandbox-network`, `--disable-write`) go in the plugin `args` option and apply to every session of that `muse serve`.
- **Muse's workspace** is the folder where the Muse session started _(code)_. For throwaway runs, start the session in a git worktree or a copy.
- **Contributor mode**: subscriptions start with it on, so Meta may train on your prompts and code. Pass `args: ["--contributor-mode", "off"]` or turn it off in `muse` with `/settings`.

## Other limits

- **Kimaki**: Muse does not get Kimaki's instructions or env vars, so it does not know the `kimaki` CLI (uploads, buttons, `kimaki send`). Discord still shows its replies and tool calls.
- **Slower turns**: Muse's reviewer adds about 5 seconds to each shell command and new network host. The first turn also starts `muse serve`, which stays up 10 minutes after the last turn _(code)_.
- **Pinned protocol** _(code)_: built on `@muse-code/sdk` 1.4.14. The device login reuses the `muse` CLI's own Meta client ID, so a Muse update can break it.
