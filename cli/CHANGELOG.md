# Changelog

## 0.19.0

1. **Compact session markdown export** — `kimaki session read` now renders tool calls as compact one-liners by default, showing the tool name, key parameters, and output line count instead of full YAML inputs and raw output blocks. This makes exported sessions much more readable and smaller, especially for sessions with many file reads and grep results.

   ```
   > 🛠️ **bash** command=echo hello, description=Print greeting (2 lines)
   > 🛠️ **read** filePath=src/config.ts (124 lines)
   ```

   Use `--verbose` to get the full tool output when you need it:

   ```bash
   kimaki session read <session-id> --verbose
   ```

2. **Fix `kimaki send` failing in CI/headless environments** — `kimaki send --channel <id> --prompt "..."` no longer requires a local SQLite database with channel-to-directory mappings. Previously, this mapping (populated when the bot runs locally) was required unconditionally, making it impossible to use `kimaki send` from CI runners or GitHub Actions. Now the local project directory mapping is only required for `--send-at`, `--wait`, and `--cwd`. The basic flow (post message, create thread, let the remote bot pick it up) works with just `KIMAKI_BOT_TOKEN`.

3. **Fix `--wait` and `--send-at` erroring after message was already sent** — the channel config requirement check now runs before posting the Discord message, so these flags fail early with a clear error instead of posting the message and then crashing.

## 0.18.0

1. **New `kimaki bot token` command** — prints the bot token for CI and automation use. In self-hosted mode it prints the Discord bot token; in gateway mode it prints the `clientId:clientSecret` credential.

   ```bash
   # Print your token (works in both self-hosted and gateway modes)
   kimaki bot token

   # Store it as a GitHub Actions secret
   kimaki bot token | gh secret set KIMAKI_BOT_TOKEN
   ```

   Set the output as `KIMAKI_BOT_TOKEN` in your CI environment to let `kimaki send` and other CLI subcommands authenticate without interactive setup.

2. **Harden gateway reconnect restart for sustained network outages** — previously, when the gateway proxy was unreachable (DNS down, network outage), kimaki would hit the 50-reconnect limit, trigger self-restart, crash during cleanup from uncaught discord.js shard errors, and permanently exit. Now uncaught exceptions during shutdown are suppressed, client listeners are removed before destroy, transient network errors on initial connection allow the wrapper to retry, and progressive restart backoff (2s → 4s → 8s → 16s, capped at 30s) prevents hammering DNS. The existing crash loop detector (5 crashes in 60s) still acts as the ultimate circuit breaker.

3. **Fix slash commands handled by the wrong machine in multi-machine setups** — when kimaki is installed on multiple machines sharing the same Discord guild via gateway proxy, interactions (slash commands, buttons, select menus, modals) were processed by every machine regardless of channel ownership. Now the interaction handler checks if the channel has a project directory configured in the local SQLite database before processing; if not, the interaction is silently ignored so the correct machine handles it.

4. **Fix workspace worktree setup and cleanup** — worktree creation now correctly parses `.gitmodules` inside the plugin-safe workspace adaptor so submodules initialize. Deleting a worktree from `/worktrees` now removes the matching OpenCode workspace record through the workspace SDK before deleting the local thread mapping, keeping OpenCode workspace state, git worktrees, and Kimaki thread metadata in sync.

5. **Fix multi-question Discord dropdowns submitting incomplete answers** — duplicate select interactions on one dropdown could submit empty answers for later questions. Kimaki now derives question completion from the actual answered question indexes instead of incrementing a counter.

6. **Add `--no-auto-upgrade` CLI flag** — disables the background auto-upgrade check on startup. Useful for pinned deployments or air-gapped environments.

   ```bash
   kimaki --no-auto-upgrade
   ```

7. **Fix gateway install URL on Windows** — the Discord OAuth install URL now opens correctly on Windows during onboarding. Thanks @TheLonelyDevil9 for #152!

## 0.17.1

1. **Fix gateway onboarding flow silently failing** — the CLI would get stuck on "Still waiting..." after the user authorized the bot. Discord doesn't always include `guild_id` in the OAuth callback URL (e.g. when previously authorized). Now the `guild_id` is cached in KV before the callback, `prompt` is set to `consent` so the authorization screen always shows, and specific onboarding errors are surfaced to the CLI instead of a generic timeout.

2. **Fix `/worktrees` and `/last-sessions` exceeding Discord limits** — these commands could exceed Discord's 40-component limit or 4000-char text limit for large worktree/session lists. Components are now truncated intelligently (removing rows from containers instead of dropping entire containers) with a notice showing how many items were hidden.

3. **Stop adopting another instance's default channel in shared guilds** — when two kimaki installations (different `client_id`) connected to the same Discord guild via the gateway proxy, the second instance would claim the first instance's "kimaki" channel. Each instance now only manages channels it created itself.

4. **Skip joining voice channels without an API key** — the bot no longer joins Discord voice channels when no Gemini API key is configured. Previously it would join and immediately fail. Now it logs a message telling the user to set an API key via `/audio-api-key`.

5. **Fix silent interaction errors** — interaction handler now properly distinguishes `deferReply` vs `deferUpdate` when following up, preventing "Unknown Webhook" errors on component interactions.

## 0.17.0

1. **xAI Grok Composer 2.5 Fast model available by default** — the `grok-composer-2.5-fast` model from xAI is now registered in Kimaki's default opencode config, so all users can select it via `/model` without manual configuration. 256k context, 256k output, supports attachments and tool calls.

2. **Forked sessions preserve the source model** — when `/btw` forks a side-question thread or `/new-worktree` creates a worktree from an existing thread, the new session now uses the same model as the source session instead of falling back to the default.

3. **Clear worktree marker on empty merge** — `/merge-worktree` now removes the worktree marker from a thread title when there are no commits to merge (branch is already up to date), instead of leaving it marked as unmerged.

4. **Improved `/btw` fork behavior** — forked sessions no longer proactively suggest sending messages back to the parent session. The agent only does so when the user explicitly asks.

## 0.16.0

1. **Gateway mode re-enabled in onboarding wizard** — the "Gateway (pre-built Kimaki bot)" option is available again when running `kimaki` for the first time. Discord raised the privileged intent threshold from 100 servers to 10,000 users on June 10, 2026, so the shared bot no longer needs verification.

2. **Long `--notify-only` messages are split instead of attached as files** — when `kimaki send --notify-only` has a prompt over 2000 characters, the content is now split into multiple Discord messages using the same markdown-aware splitter used in threads. Previously it was sent as a `.md` file attachment, making the content harder to read directly in the channel.

## 0.15.0

1. **New `kimaki session abort` command** — stop a running session without archiving the thread. The thread stays visible in Discord so you can inspect what happened. A "Session aborted via CLI" message is posted in the thread.

   ```bash
   kimaki send --channel 123 --prompt 'wrong stuff'
   # Output:
   # Session: ses_abc123
   # https://discord.com/channels/...

   kimaki session abort ses_abc123
   ```

2. **`kimaki send` now prints the session ID** — alongside the thread URL. For new threads, the CLI polls the database for up to 15 seconds waiting for the bot to create the session. For existing threads, the session ID is looked up immediately.

3. **Allow `--agent` and `--model` with `--thread`/`--session` in `kimaki send`** — previously the CLI rejected these flags for existing threads with "Incompatible options with --thread/--session". Now they are accepted and included in the thread prompt marker so the bot picks them up. Fixes #146

   ```bash
   kimaki send --thread 123456 --prompt 'fix the bug' --agent plan
   kimaki send --session ses_abc --prompt 'run tests' --model anthropic/claude-sonnet-4-20250514
   ```

4. **Allow `kimaki send --notify-only` to target any Discord channel** — previously every channel had to have a project directory mapping. Now `--notify-only` on a non-project channel posts the message directly without creating a thread. Scheduled tasks (`--send-at`) also work.

5. **Auto-reject permission requests in subagent sessions** — permission prompts from Task/subtask agents are now automatically denied instead of showing buttons that nobody clicks. This prevents subagent sessions from hanging indefinitely on permission prompts.

6. **Filter disabled skills from Discord slash command registration** — `--disable-skill` and `--enable-skill` flags now also prevent the corresponding skill commands from being registered as Discord slash commands, freeing up slots for commands the user actually wants. Fixes #145

7. **Parallelize `/btw` and `/new-worktree` commands** — session lookup, opencode init, and parent channel resolve now run concurrently in both commands, reducing latency.

8. **Pass parent session ID into `/btw`-forked sessions** — the agent in a forked session can now send messages back to the parent session using `kimaki send --session <parent_id>`.

9. **Clickable source thread links in fork/btw messages** — `/fork` now includes a clickable `<#threadId>` link to the source thread in the "Forked session created" message.

10. **Self-restart on gateway reconnect limit** — after 50 consecutive failed Discord gateway reconnect attempts, the process self-restarts using the same spawn-and-exit pattern as SIGUSR2 instead of retrying forever.

11. **Fix stale permission buttons when plugin auto-rejects** — permission buttons from previous prompts are now dismissed when the plugin auto-rejects.

## 0.14.0

1. **Configurable permission timeout with model continuation on deny** — new `--permission-timeout-minutes <minutes>` flag controls how long permission buttons stay active before auto-rejecting (defaults to 10 minutes). When a permission times out or the user clicks Deny, the model now sees it as a tool error and continues working (tries alternatives or explains what happened) instead of the session going dead silent. The timeout message also tells the model to mention the thread owner if the tool call is essential.

   ```bash
   kimaki --permission-timeout-minutes 30
   ```

   Closes #140

2. **Single global SSE connection replaces per-thread listeners** — previously every Discord thread opened its own SSE connection to the opencode server. With 20+ idle threads, all connections disconnected and reconnected simultaneously, flooding logs with reconnect messages. Now a single `/global/event` connection broadcasts events to all thread runtimes, matching how the opencode TUI works. Fixes #126

3. **Queue edit and removal notifications** — when a user edits a queued message in Discord, the thread now shows `⬦ **username** edited queued message`. If the edit removes the queue suffix, it shows `⬦ **username** removed message from queue`. The queue confirmation also tells users they can edit the message to update it.

4. **User input indicators for buttons, dropdowns, and file uploads** — action button clicks, question dropdown answers, and file uploads now show the `» **username:** action` prefix in Discord threads, matching the existing pattern for queued messages and agent commands.

5. **Fix `/model` and `/model-variant` not updating current session for global/channel scope** — selecting "global" or "channel" scope previously persisted the preference but the running session kept the old model until the next message. All three scopes now update the current session and restart the request with the new model.

6. **Fix bot becoming permanently unresponsive after gateway proxy outages** — `@discordjs/rest` calls `setToken(null)` on any 401 response. When the gateway proxy returned transient 401s, this killed the REST token permanently and every subsequent API call failed. The fix blocks null token values so the bot recovers automatically when the proxy comes back.

7. **Fix stale interrupt timers aborting unrelated generations** — the interrupt plugin now clears pending timers on errored assistant messages and on session idle events, preventing timers from surviving across turns and aborting later work.

8. **Worktree base branch discovery in system message** — the agent now gets instructions for finding its worktree starting point via `git merge-base` and `git symbolic-ref`, useful for diffs and merge decisions.

9. **Fix OpenCode server auth passthrough** — when `OPENCODE_SERVER_PASSWORD` is set (e.g. inherited from a parent OpenCode process), the SDK client now sends Basic auth headers so `session.promptAsync` and `event.subscribe` work correctly. Thanks @Dxee-e for #139!

10. **Prevent `@username` pings in scheduled task prompts** — scheduled task prompts become Discord thread titles, so raw `@username` triggered real pings on every task run. The system message now instructs the model to use Discord user ID mentions instead.

## 0.13.1

1. **Fix session interrupts being silently dropped** — sending a new message while the bot was mid-run (e.g. during a long tool call) often failed to abort and replay the queued message. Two root causes: the plugin's `ctx.client` didn't make REST calls reliably (now builds its own SDK client from `ctx.serverUrl`), and abort confirmation now polls session status instead of waiting on events that sometimes never arrived.

2. **Fix `/new-worktree` in existing threads forking to a separate thread** — running `/new-worktree` inside an active thread no longer switches the current thread in-place. The original thread keeps its session and checkout; a new thread gets the worktree, the forked session context, and the metadata for `/merge-worktree`.

3. **Fix OpenAI voice transcription** — voice messages configured with an OpenAI API key work again. The deprecated `gpt-4o-audio-preview` model is replaced with the current `gpt-audio` chat model.

4. **Fix kimaki shim aborting with `.env: not found`** — the relocatable shim at `~/.kimaki/bin/kimaki` no longer leaks `--env-file` flags from the bot's startup args. Running `kimaki` subcommands from directories without a `.env` file no longer crashes.

5. **Upgrade `@opencode-ai/sdk` and `@opencode-ai/plugin` to 1.15.11** — adapts to the newer SDK event types (top-level `id` field on every event) and centralizes error message extraction across SDK response shapes.

## 0.13.0

1. **New `--allow-mention` CLI flag** — control which Discord mention types the bot can trigger. Default is `users` only, which prevents the bot from pinging `@everyone`, `@here`, or roles. Repeatable flag to allow additional types:

   ```bash
   kimaki --allow-mention users --allow-mention roles
   ```

   Valid values: `users`, `roles`, `everyone`.

2. **Support editing queued messages via Discord message edits** — when a user edits a Discord message that is still waiting in kimaki's local queue (messages ending with `. queue`), the queue item is updated with the new content. If the edit removes the queue suffix, the item is removed from the queue entirely.

   ```
   User sends:    "fix the bug. queue"     → queued at position 1
   User edits to: "fix it properly. queue" → queue item updated
   User edits to: "fix it properly"        → item removed from queue
   ```

   Messages that were already dispatched to opencode (dequeued) are unaffected by edits.

3. **Change `btw` shortcut from prefix to suffix detection** — now only triggers when preceded by punctuation or a newline (e.g. `fix the bug. btw check tests`), matching the same pattern as the queue suffix. The text before `btw` continues in the current session while the btw prompt forks to a new thread.

4. **Make state-changing slash commands non-ephemeral** — `/upgrade-and-restart`, `/abort`, `/undo`, `/redo`, `/restart-opencode-server` replies are now fully visible to all users and trigger normal Discord notifications. Error replies remain ephemeral.

5. **Fix interrupt replay after abort** — kimaki now waits for OpenCode's post-abort idle event before replaying the interrupting user message, so the replay is not queued behind the cancelled run and its assistant response is visible in Discord. Fixes #133

6. **Fall back to default agent when requested agent not found** — if `kimaki send --agent foo` references an agent that doesn't exist in the project's opencode config, it logs a warning and uses the default agent instead of failing. Closes #136

7. **Use `caffeinate -s` for lid-close keep-awake** — the Mac stays awake even with the lid closed when on AC power. On battery, macOS still sleeps normally to preserve charge.

## 0.12.0

1. **New `--disable-sync` flag** — turn off background mirroring of external OpenCode sessions into Discord:

   ```bash
   kimaki --disable-sync
   ```

   When enabled (default), sessions started from the OpenCode CLI or TUI automatically appear as Discord threads in the matching project channel. Use `--disable-sync` if you only use Kimaki through Discord and don't need the mirroring. The background sync loop also now uses per-directory timeouts with proper cancellation, so one slow or unresponsive OpenCode server cannot block syncing for other projects.

2. **Opencode is no longer bundled** — Kimaki no longer downloads and pins a specific opencode version. It requires opencode to be installed globally. On startup, the bot checks PATH and prompts to install if missing via `curl -fsSL https://opencode.ai/install | bash`. This avoids version skew issues where an older bundled opencode ran alongside a newer global one. The `kimaki opencode` passthrough command has been removed accordingly.

3. **Discord embeds, polls, and forwarded messages are now visible to the AI** — previously, Discord embeds (link previews, rich embeds), polls, and forwarded message snapshots were invisible to the AI model. Now they are serialized as structured text and included in the message context. This also works for replied-to messages.

4. **State-changing slash commands are now visible to all users** — `/model`, `/model-variant`, `/agent`, `/verbosity`, `/toggle-worktrees`, `/toggle-mention-mode`, and `/unset-model` responses are no longer ephemeral. Everyone in the channel can see when someone changes the model or agent. Error-only early returns and credential-sensitive commands remain ephemeral.

5. **Fix quick agent commands with inline prompts** — using `/plan-agent <prompt>` now correctly starts or continues the session with the `plan` agent instead of only borrowing that agent's model while OpenCode still ran the previous agent.

6. **Harden Discord permission checks** — messages from uncached guild members now fetch the member before deciding access, autocomplete no longer exposes project metadata to unauthorized users, and live voice audio is ignored unless the speaker has Kimaki access.

7. **Fix model/provider select menu crashes** — select menus no longer crash when a model name or provider name is undefined or exceeds Discord's character limits.

## 0.11.0

1. **New `kimaki tts` command for text-to-speech audio generation** — generate speech audio from text using OpenAI (`gpt-4o-mini-tts`) or Google Gemini (`gemini-2.5-flash-preview-tts`). Provider is auto-detected from the API key prefix (`sk-*` = OpenAI, otherwise Gemini).

   ```bash
   # Generate audio file
   kimaki tts "Hello world" --voice alloy --output greeting.mp3

   # Generate and upload directly to a Discord thread
   kimaki tts "Build summary" --session ses_xxx
   ```

   API keys are resolved from the database (same keys set via `/transcription-key`), then falls back to `OPENAI_API_KEY` / `GEMINI_API_KEY` env vars.

2. **New `--allow-all-users` flag** — bypass role and permission checks so any Discord member can start sessions and use slash commands without needing the Kimaki role, Administrator, or Manage Server permissions. The `no-kimaki` role still blocks access even when this flag is enabled. Credential-sensitive commands (`/login`, `/transcription-key`) remain restricted to admins.

   ```bash
   kimaki --allow-all-users
   ```

3. **One-shot prompts on quick agent commands** — `/plan-agent`, `/build-agent`, and other quick agent commands now accept an optional `prompt` argument. When provided, the prompt is sent with that agent as a temporary override without changing the persistent agent preference:

   ```
   /plan-agent prompt: fix the login bug
   ```

   In a thread this enqueues on the existing session; in a channel it creates a new thread.

4. **Clear stale global Discord commands on startup** — Kimaki registers slash commands as guild commands so updates are immediate. Startup now also bulk-clears global commands for self-hosted bots, removing older commands that are no longer registered and preventing duplicate stale entries from staying visible in Discord.

5. **Truncated session error messages in Discord** — provider error payloads can include enormous response bodies. Kimaki now truncates error messages to 400 characters, keeping them concise while still showing the important prefix and provider status.

## 0.10.2

1. **Pinned opencode binary to v1.14.41** — Kimaki now downloads the opencode binary from GitHub releases on first run instead of relying on a globally installed binary. The binary is cached at `~/.kimaki/bin/opencode-{version}` and old versions are cleaned up automatically. The `OPENCODE_PATH` env var still works as an explicit override. This prevents new opencode releases from unexpectedly breaking Kimaki for all users.

2. **Fixed infinite event stream reconnect loop** — the bot no longer locks up when the opencode SSE endpoint closes the connection normally. The listener loop now uses exponential backoff (500ms up to 30s) before reconnecting, and backoff only resets after the stream delivers at least one event.

## 0.10.1

1. **Fixed event stream reliability** — reverted to per-directory event subscription, avoiding spurious events from other sessions leaking into the active thread.

## 0.10.0

1. **Auto-grant cross-project directory access via channel mentions** — mention a registered project channel like `#website` in your message and Kimaki automatically grants the active session access to that project's directory. Works on both thread-starting messages and follow-ups, so cross-project requests can inspect referenced folders without a manual `/add-dir` step first.

2. **New `kimaki session wait <sessionId>` command** — wait on an existing session without passing a project path. The command resolves sessions from the local database, blocks until OpenCode is idle (including through permission prompts), and prints the final session markdown to stdout.

3. **`kimaki send --cwd` supports project subfolders** — scheduled and immediate sends can now target a subdirectory of the channel project as the OpenCode working directory. This lets you keep a restricted `opencode.json` in a subfolder and run recurring tasks there:

   ```bash
   kimaki send --project /repo --cwd /repo/restricted-task --send-at '0 9 * * 1' --prompt 'Run the restricted task'
   ```

4. **Migrated local database from Prisma to Drizzle** — the CLI now uses Drizzle/libSQL for all local SQLite operations. Same on-disk database, same startup migration behavior, but Prisma is no longer bundled in the published package. This reduces install size and simplifies the database layer.

5. **Fixed startup healthcheck hangs** — Kimaki no longer gets stuck forever at `Waiting for OpenCode server...` when the server accepts the TCP connection but delays the HTTP response. Each healthcheck request now has a timeout and keeps polling. Fixes #123

6. **Fixed Hrana SQLite schema bootstrap** — fresh databases created through the local Hrana HTTP bridge now receive the same schema bootstrap as direct file connections, preventing `no such table: bot_tokens` errors on first startup.

7. **Fixed OpenCode 1.14 event stream handling** — adapted to OpenCode's global event subscription API so session events dispatch correctly. Thanks @ian-pascoe for #125.

8. **Improved session routing guidance** — agents are now told to use the current channel by default, only target another project channel or checkout path when the user explicitly asks, and only create worktrees when explicitly requested.

## 0.9.1

1. **Fixed worktree sessions for non-git-root project folders** — when worktrees are enabled but the configured project folder is not the git repository root, Kimaki now falls back to a normal session in that folder instead of creating a broken worktree record that makes every follow-up message reply with a worktree error. Fixes #112

2. **`kimaki tunnel` auto-detects port without `--port`** — when running `kimaki tunnel -- <dev server>`, Kimaki now waits for the dev server to print a localhost URL or port line and detects the port automatically. The `--port` flag is still available for servers that don't print a detectable port.

## 0.9.0

1. **Multi-provider OAuth account rotation** — Kimaki now manages OAuth account pools for both Anthropic and OpenAI. Accounts are rotated on rate-limit retries, and OpenAI tokens display extracted identity metadata when available:

   ```bash
   kimaki multioauth list
   kimaki multioauth anthropic list
   kimaki multioauth anthropic current
   kimaki multioauth openai list
   kimaki multioauth openai current
   kimaki multioauth openai check
   ```

2. **`kimaki send --user` works without Server Members Intent** — the `--user` flag now accepts raw Discord IDs and mentions directly, so servers that lack the privileged intent can still target users from the CLI:

   ```bash
   kimaki send --channel 123 --prompt 'Review this' --user '535922349652836367'
   kimaki send --channel 123 --prompt 'Review this' --user '<@535922349652836367>'
   ```

   Onboarding now only requires Message Content Intent. If member lookup fails, Kimaki shows fallback guidance instead of crashing.

3. **Respect manual Discord thread renames** — if you rename a thread after Kimaki created it, future OpenCode title syncs and bot restarts will preserve your custom name instead of overwriting it. Fixes #115

4. **Preserve Anthropic project instructions** — the system prompt sanitizer now only strips the OpenCode identity block, keeping project instructions, skill instructions, and agent context intact. Fixes #116

5. **Clearer `/merge-worktree` failures** — when the target worktree has uncommitted changes, the error now tells you to commit or clean the main worktree first instead of showing a generic git push failure.

6. **Fix voice agent selection** — casual mentions of agent names (like "ask the build agent what changed") no longer accidentally switch the active agent. Only clear command phrases at the start of a message trigger agent selection.

7. **Handle unreadable Discord messages** — when Message Content Intent is unavailable and Discord withholds text, Kimaki now tells the user to mention the bot instead of creating empty threads. Also points to `--mention-mode` for intentional setups.

8. **Removed personal-only skills from npm package** — shipped skills now exclude workflow-specific tools like `jitter`, `proxyman`, `x-articles` that belong in personal config.

9. **Quieter `kimaki project add`** — removed redundant pre-create log message during channel creation.

## 0.8.1

1. **Fixed Bun crash on startup** — `bunx --bun kimaki@latest` crashed with `TypeError: null is not an object (evaluating 'body.pid')` during Hrana server startup because Bun's `response.json()` can return `null` instead of throwing. Added null guards across all fetch `.json()` call sites.

## 0.8.0

1. **New `/last-sessions` command** — list the 20 most recently active sessions across all projects, sorted by last activity. Shows a table with clickable thread links and project names:

   ```text
   /last-sessions
   ```

2. **Model and agent banner on new sessions** — when a new session thread is created, Kimaki now sends a silent status message showing the active model and agent (e.g. "using anthropic/claude-sonnet-4 · build"), so you always know which model is handling your request.

3. **`/add-dir` now applies to busy sessions immediately** — previously the permission update only took effect on the next turn. Now Kimaki aborts and restarts any active run in the affected session so OpenCode picks up the new permissions right away. Idle sessions are left untouched.

4. **Resume idle sessions after permission replies** — permission accepts that arrive after OpenCode has already gone idle (e.g. from auto-rejected or interrupted runs) now resume the session automatically. Expired permission prompts also update their Discord message to explain the expiry.

5. **CLI JSON output is pipe-safe** — logger diagnostics are now routed to stderr so subcommands like `kimaki project list --json` can safely pipe stdout to `jq` without noise.

6. **Fix: resolved model now passed correctly to opencode user commands** — custom opencode commands receive the correct model override instead of the default.

## 0.7.1

1. **Fix: Claude subagent sessions (Task tool) now work correctly** — the Anthropic auth plugin now handles the subagent prompt structure. Subagent sessions spawned via the Task tool use a different system prompt format ("You are powered by the model named…" + `<env>` block) instead of the main-session `OPENCODE_IDENTITY` marker. The plugin now strips both patterns correctly, so Claude API calls from subagents no longer fail with malformed/oversized system prompts.

2. **Fix: working directory extraction from updated OpenCode system prompt format** — OpenCode changed its environment block from `<environment><cwd>/path</cwd></environment>` to `<env>\nWorking directory: /path\n</env>`. The plugin now reads the new `Working directory:` format first and falls back to the old `<cwd>` tag for backwards compatibility. Fixes incorrect per-session directory in multi-session and worktree setups.

3. **Fix: callout blocks now render as colored containers** — `<callout>` tags were getting the `⬥` text prefix because `<` was not in the markdown starters list. The prefix is now skipped for callout tags so the Discord Components V2 parser sees them correctly and renders them as accent-colored containers.

## 0.7.0

1. **New `/fork-subagent` command** — fork an active subagent task session into its own Discord thread. Shows a dropdown of running subagent tasks with their prompt previews. The new thread inherits the full session context (memory, tool outputs, event history) so you can continue the subagent's work independently:

   ```text
   /fork-subagent
   ```

2. **Callout containers in Discord** — the bot now renders accent-colored callout blocks (warnings, tips, action-required notes) as Discord Components V2 containers. Callouts can recursively include tables and action buttons, making structured responses easier to scan. The system prompt includes color-coded callout types: orange for warnings, blue for TODOs, red for tool failures, purple for gist summaries.

3. **`/add-dir` directory option now optional** — omit the directory argument to default to `*` (all directories) for the current session. Explicit paths are still resolved against the active worktree when provided:

   ```text
   # Allow all directories (no argument needed)
   /add-dir

   # Allow a specific directory (still works)
   /add-dir ../shared-data
   ```

4. **Fix: Anthropic plugin per-session directory resolution** — the Anthropic auth plugin now extracts the per-session working directory from the OpenCode identity block instead of using the server's cwd. Fixes incorrect file paths in multi-session and worktree setups.

5. **Fix: faster startup when replacing a running instance** — the Hrana database server now polls the old process every second during eviction instead of sleeping a fixed 6 seconds. Startup is faster when the old instance shuts down promptly while still allowing graceful cleanup.

## 0.6.0

1. **Subagent rate-limit handling** — when a task-created child session hits a provider rate limit (HTTP 429), kimaki now automatically aborts the subagent session instead of letting the error cascade to the parent. The parent task session recovers on its own, keeping rate-limit noise out of your Discord threads.

2. **Bash tool for the voice assistant** — the GenAI worker now includes a shell execution tool that can run commands in the project directory. It also supports remote skill loading: skill SKILL.md files fetched from URLs are cached locally and their metadata is injected into the tool description so the model can discover specialized workflows.

3. **Common toolchain caches pre-allowed** — zig, cargo, go build, and go pkg cache directories under `~` are now pre-allowed as external directories. Agents using these toolchains no longer trigger permission prompts for inspecting downloaded modules and build artifacts.

4. **Fixed infinite abort-replay loop on large contexts** — when the LLM took >3 seconds to return the first token (e.g. 239K token prompts), the interrupt plugin would abort and replay the message in a tight loop every 3 seconds. Replayed message IDs are now tracked to break the cycle.

5. **Fixed unscoped Discord toasts** — global plugin toasts without a session-scoped marker were being forwarded into unrelated Discord threads. Toasts are now only rendered when they carry a session ID, preventing rate-limit and status toasts from spamming conversations.

6. **Fixed Anthropic OAuth identity in system prompt** — the Anthropic auth plugin now correctly rebrands the openc0de identity and allows `~/.config/openc0de` as a valid config directory, fixing repeated auth failures.

7. **Fixed home directory resolution bug** — corrected path resolution for the user's home directory in opencode startup.

## 0.5.0

1. **New `/add-dir` Discord command** — expand the current session's directory access permissions without restarting. In a thread with an active session, run `/add-dir <path>` to grant the AI access to a specific external directory, or `/add-dir *` to allow all directories:
   ```text
   /add-dir ../other-project
   /add-dir /tmp/shared-data
   /add-dir *
   ```

2. **Worktree sessions can no longer edit the main checkout** — when a thread moves into a git worktree, existing and newly created sessions automatically deny write access to the original repo path. This prevents the agent from accidentally modifying the main branch while working in a worktree.

3. **System prompt drift notices show inline diff snippets** — the "Context cache discarded" toast now includes a short markdown diff snippet directly in Discord, instead of writing a debug file to disk. Makes it immediately visible which parts of the system prompt changed.

4. **`kimaki tunnel` now injects `TRAFORO_URL` into the child process** — apps launched through `kimaki tunnel` can read `process.env.TRAFORO_URL` to wire OAuth callbacks, webhook URLs, and absolute links to the public tunnel instead of localhost:
   ```bash
   kimaki tunnel -- sh -c 'BETTER_AUTH_URL=$TRAFORO_URL exec pnpm dev'
   ```

5. **Fixed OpenCode directory resolution for worktree sessions** — agent, model, provider, and config calls now pass the worktree-aware directory instead of the client default, so worktree sessions resolve against the active checkout correctly.

6. **Fixed OpenCode log chunking** — stderr/stdout from the opencode server process is now read line-by-line instead of splitting raw chunks, preventing garbled or merged log lines.

## 0.4.104

1. **Queued messages now keep moving while question dropdowns are open** — if the assistant asks a dropdown question and you queue a follow-up message, kimaki now hands off the first queued item immediately instead of waiting for the dropdown to be answered. This keeps the visible `» user:` dispatch indicator moving and prevents queued work from feeling stuck behind interactive prompts.

## 0.4.103

1. **`btw` message shortcut for side-question forks** — type `btw fix the auth bug` directly in a thread to fork the session with full context, without using the `/btw` slash command. Supports punctuation separators like `btw. check this`, `btw, why is this broken`, `btw: look at that`. Thread titles preserve the `btw:` and `Fork:` prefixes when OpenCode renames them.

2. **`--enable-skill` / `--disable-skill` flags** — control which bundled skills get injected into the model's system prompt:
   ```bash
   # only load specific skills
   kimaki --enable-skill drizzle --enable-skill errore

   # hide noisy skills
   kimaki --disable-skill jitter --disable-skill termcast
   ```
   Flags are mutually exclusive (whitelist vs blacklist) and repeatable.

3. **`/worktrees` now shows all worktrees, not just kimaki-created ones** — uses `git worktree list` as source of truth, enriched with DB metadata (thread links, timestamps). Surfaces kimaki-created, opencode-created, and manually created worktrees in a single table with a Source column.

4. **Shorter worktree folder names** — worktrees now live under `<dataDir>/worktrees/<hash>/<basename>` instead of the deeply nested opencode paths with `opencode-kimaki-` prefix. Shorter paths make the agent less likely to accidentally operate on the wrong worktree.

5. **`kimaki anthropic current-account`** — prints the currently active Anthropic OAuth account email for quick inspection.

6. **Fixed Anthropic system prompt losing working directory** — `sanitizeAnthropicSystemText` was stripping the OpenCode identity block which contains environment context (cwd, OS). The model now retains awareness of the current working directory after the Anthropic rewrite.

7. **Fixed duplicate question dropdowns** — repeated `AskUserQuestion` tool requests no longer produce duplicate Discord select menus. Stale contexts are cleaned up on answer, cancel, or expiry.

8. **Fixed queue drain dumping all messages at once** — answering a dropdown question no longer flushes every locally queued message into OpenCode simultaneously. Only the next queued message is dispatched, preserving normal one-by-one Discord indicators.

9. **Fixed duplicate task start messages** — repeated tool updates for the same part no longer post the same Discord line twice.

10. **Skills from `~/.config/opencode/skills/` now load correctly** — fixed path resolution for user-installed skills outside the bundled skills directory.

## 0.4.102

1. **Fixed OpenCode plugin failing to load in the published npm package** — kimaki now loads `dist/kimaki-opencode-plugin.js` in published builds instead of the TypeScript source entrypoint, which imported `.js` sibling files that don't exist under `src/` in the npm tarball. Users running kimaki under PM2 or npx saw `ERR_MODULE_NOT_FOUND: Cannot find module 'ipc-tools-plugin.js'` on startup; this is now fixed.

2. **`~/.opensrc` is now pre-allowed in OpenCode permissions** — agents can inspect cached opensrc package checkouts without triggering interactive permission prompts.

## 0.4.101

1. **Claude Max login works again when Anthropic shows the new third-party app billing prompt** — kimaki now rewrites Anthropic's transformed system prompt in the hook Anthropic actually reads, so OAuth login keeps working when Claude shows messages like "Third-party apps now draw from your extra usage" instead of silently falling back to a broken prompt state.

2. **`MEMORY.md` heading overview is now frozen per session** — kimaki snapshots the condensed `MEMORY.md` table of contents on the first real user message and reuses that same overview for the rest of the session. Editing `MEMORY.md` mid-session no longer mutates the active system prompt or invalidates the session cache; starting a new session still picks up the latest headings.

3. **`/login` now surfaces `opencode` and `opencode-go` providers** — the provider picker prioritizes both entries so they are easier to find when signing in through Discord:
   ```text
   /login
   ```

## 0.4.100

1. **`/vscode` now opens reliably through the Kimaki tunnel** — the browser editor no longer depends on Coderaft's `?tkn=` connection-token redirect flow, which could fail and return `Forbidden` after passing through the public tunnel. Kimaki now launches Coderaft without a connection token and returns the unique tunnel URL directly:
   ```text
   /vscode
   ```
   The session still auto-stops after 30 minutes, and the generated tunnel host remains high-entropy and hard to guess.

## 0.4.99

1. **Existing gateway installs now auto-migrate to `kimaki.dev`** — on startup, kimaki rewrites saved gateway proxy URLs from `discord-gateway.kimaki.xyz` to `discord-gateway.kimaki.dev` in local SQLite for gateway mode. This prevents legacy endpoint drift that could cause Discord interactions to time out with "application did not respond".

## 0.4.98

1. **New `/vscode` Discord command** — open the current project or worktree in browser VS Code (Coderaft) through a private tunnel, with automatic 30-minute shutdown. This is useful for quick remote edits without leaving Discord:
   ```text
   /vscode
   ```

2. **`kimaki.dev` is now the default domain for new sessions and links** — default onboarding website URL, gateway proxy URL, and tunnel-based features now point to `kimaki.dev`. Existing `kimaki.xyz` routes remain supported during migration.

3. **System prompt drift notices are less noisy** — drift detection now waits until system-transform hooks finish mutating the prompt before comparing turns, reducing false positives in "Context cache discarded" toasts.

## 0.4.97

1. **Anthropic account CLI commands are now visible in help** — `kimaki anthropic account list/add/remove` commands appear in normal `--help` output. `remove` now accepts either a 1-based index or a stored email address for easier cleanup.

2. **Anthropic account identity persisted across OAuth rotation** — kimaki fetches your Anthropic profile email and account IDs during login and stores them alongside credentials. Account records are deduplicated by stable identity so rotating tokens doesn't create phantom duplicate entries.

3. **Anthropic plugin toasts scoped to the active session** — account-switch and rewrite warnings now appear only in the Discord thread that triggered the event instead of broadcasting to all threads.

4. **Worktrees now branch from current HEAD** — new worktrees start from whatever your local checkout is at, including commits that haven't been pushed yet. Previously, only the remote `origin/HEAD` was used as the base.

## 0.4.96

1. **System prompt drift toasts now route to the correct Discord thread** — toasts from the `systemPromptDriftPlugin` are now scoped to the active session's thread. A hidden session marker is appended in the plugin and stripped before rendering, so drift notices appear only in the thread that triggered the event instead of broadcasting globally.

2. **Simpler debug filenames for system prompt drift** — saved system prompt and diff files now share a timestamped basename (e.g. `2026-04-08T10-01.md` / `2026-04-08T10-01.diff`) instead of using the session ID, keeping the debug paths shorter and each event self-contained.

3. **Cleaner drift toast copy** — diff and latest-prompt paths are now shown as inline code; wording is lower-cased and the extra explanatory sentence is removed to keep the notice concise.

## 0.4.95

1. **Fixed Claude Max subscription prompt stripping** — instead of replacing the entire system prompt or splicing out the whole OpenCode identity block, kimaki now removes only the section from `"You are OpenCode…"` up to `"# Code References"`, preserving the rest of the prompt that Anthropic's API expects. This restores correct behaviour for Claude Pro/Max OAuth users. Shows a toast error if the expected marker is not found.

2. **Fixed discord.js CJS interop in plugin chain** — the plugin loader now uses a namespace import for discord.js to avoid CJS/ESM interop crashes when running inside the OpenCode plugin host process.

## 0.4.94

1. **Fixed Claude Max subscription support** — the error message "Third-party apps now draw from your extra usage, not your plan limits" no longer breaks authentication. Kimaki now correctly detects active Max subscriptions and continues using them without requiring a re-login.

2. **New `systemPromptDriftPlugin`** — detects when the effective system prompt changes between turns inside an OpenCode session. When drift is detected, it writes a unified diff to the Kimaki data directory and shows a Discord toast with addition/deletion counts, making it easy to spot which plugin is busting the prompt cache and driving up rate-limit usage.

3. **Log output is now capped at 1 000 characters per argument** — prevents runaway log files when tools return very large outputs. Truncated portions show a `… [truncated N chars]` suffix so nothing is silently dropped.

4. **Softer wording on worktree directory reminders** — the mid-session reminder injected when switching to a worktree now says "You should read, write, and edit files under …" instead of "You MUST …", reducing unnecessary alarm in the agent's context.

## 0.4.93

1. **Claude account rotation is now visible in Discord** — when Anthropic OAuth hits a rate limit or auth failure and kimaki rotates to another saved Claude account, the thread now shows a toast-style notice with the account labels so you can see which account it switched from and to.

2. **`/merge-worktree` conflict recovery now preserves both sides more reliably** — when a rebase conflict happens during merge, the follow-up AI instructions now explicitly walk through reading the merge base, both sides' commit history, and both diffs before editing conflicted files. This reduces the chance of the model dropping a fix or feature while resolving conflicts.

3. **Agent-switch replies now say when the change applies** — thread-scoped `/agent` and quick `/<agent>-agent` commands now tell you the new agent takes effect on the next message, instead of implying the running turn changed immediately.

4. **Footer keeps more of long folder and branch names** — kimaki now truncates footer folder and branch labels at 30 characters instead of 15, so project info stays readable without overflowing Discord.

## 0.4.92

1. **Fixed `/command-cmd` prompts being sent to the model when the bot starts up** — when using `kimaki send --prompt '/hello-test-cmd'` (or any `/commandname-cmd` prompt), the command was routed as plain text to the model instead of being executed via `session.command`. This happened because the registered commands list is empty during the gateway startup race (before `backgroundInit` completes). The detector now falls back to suffix-stripping (`-cmd`, `-skill`, `-mcp-prompt`) when the list is empty, so commands are correctly routed regardless of startup timing. Fixes [#97](https://github.com/remorses/kimaki/issues/97).

2. **Footer truncates long folder and branch names** — project directory names and branch names longer than 15 characters are now capped with a `…` suffix so the footer line stays compact in Discord.

3. **Subagent sessions excluded from external sync** — helper task sessions (whose title ends with `subagent)`) no longer create or update mirrored Discord threads in external sync, reducing noise.

## 0.4.91

1. **New `--cwd` flag for `kimaki send`** — start a session using an existing git worktree directory instead of the main project directory:
   ```bash
   kimaki send --channel <id> --prompt 'task' --cwd /path/to/worktree
   kimaki send --channel <id> --prompt 'task' --cwd /path/to/worktree --send-at '2026-04-07T09:00:00Z'
   ```
   The path is validated against `git worktree list` to ensure it belongs to the project. If `--cwd` points to the main project directory it is silently ignored.

2. **Discord reply context in prompts** — when you reply to a Discord message in a session thread, the agent now sees what message you replied to as part of the turn context. Useful for referencing earlier responses without quoting them manually.

3. **Fixed queued prompts being dropped after an interrupted session** — when OpenCode aborted a running turn (e.g. a long tool call), follow-up messages queued via `/queue` or the bot's queue mechanism were silently discarded or sent to the wrong model. The interrupt plugin now replays the original queued message with its full prompt parts, agent, and model context after abort.

4. **Fixed external sync session discovery** — the external sync poller reverted to per-directory session listing which reliably finds active sessions. The previous global endpoint caused sync to miss sessions and show stale state in linked channels.

5. **Fixed OpenCode plugin compatibility with recent OpenCode releases** — resolved plugin startup failures caused by clack logger imports and plugin logging isolation issues that broke after upstream OpenCode changes.

6. **OpenCode server warnings and errors now appear in kimaki logs** — opencode server log output at warning level and above is forwarded to `~/.kimaki/kimaki.log`, making it easier to debug server-side issues without checking separate log files.

7. **Removed automatic Kimaki Discord role management** — the bot no longer auto-creates or repositions a "Kimaki" role in your server on startup. Role management is left to server admins.

## 0.4.90

1. **Fixed `/btw` forked sessions continuing the parent task** — the forked thread now only answers the side question and does not resume or reference whatever the original session was working on. The prompt is wrapped with explicit framing so the model stays focused on the question.

2. **Fixed `external_directory` permission defaults being overridden** — kimaki was injecting a catch-all `'*': 'ask'` rule that silently overrode whatever you set in your project's `opencode.json`. The wildcard is now removed; only the specific directory allowlists (tmpdir, `~/.config/opencode`, `~/.kimaki`, project dir, worktree origin) are kept. Fixes [#90](https://github.com/remorses/kimaki/issues/90) and [#92](https://github.com/remorses/kimaki/issues/92).

3. **`kimaki project create` now respects `--projects-dir`** — the root command already accepted `--projects-dir` but the `project create` subcommand didn't, so running it standalone always used the default path. Now `kimaki project create my-app --projects-dir /custom/path` works as expected.

4. **Added CI workflow for integration tests** — automated test runs on every push to catch regressions early.

## 0.4.89

1. **New `--injection-guard` flag for `kimaki send`** — enable prompt-injection scanning only for the session you are starting, without turning it on globally for the whole project:
   ```bash
   kimaki send --prompt 'Review this repo safely' --injection-guard 'bash:*'
   kimaki send --thread <thread-id> --prompt 'Continue with web checks' --injection-guard 'webfetch:*'
   ```
   Patterns use the form `tool:argsGlob`, and you can repeat the flag multiple times to scan several tool families in one session.

2. **Fixed scheduled sends to existing sessions** — `kimaki send --session ... --send-at ...` now reliably wakes the target thread instead of posting a message that leaves the session idle.

3. **Fixed dynamic command threads losing their arguments** — when a slash command like `/<name>-cmd`, `/<name>-skill`, or `/<name>-mcp-prompt` starts a new thread, the starter message and thread title now include the full command invocation instead of dropping the arguments.

4. **Fixed worktree folder-switch reminders** — when a session moves into a new worktree, kimaki now reminds the model about the exact previous folder it must stop editing, reducing accidental reads or writes in the old directory.

## 0.4.88

1. **Built-in prompt injection guard** — kimaki now ships with `opencode-injection-guard`. Opt-in: create `.opencode/injection-guard.json` (even an empty `{}`) in your project to activate it. A fast LLM judge inspects tool call outputs before they reach the main agent, blocking injected instructions from hijacking your coding sessions.

2. **Fixed project-level `opencode.json` permissions being ignored** — kimaki's default permissions (like `external_directory: ask`) were overriding your project's `opencode.json` settings because they were injected via `OPENCODE_CONFIG_CONTENT` which loads last in opencode's config chain. Kimaki now writes its config to `~/.kimaki/opencode-config.json` and uses `OPENCODE_CONFIG` (file path), which loads before project config — so your project-level permission settings are correctly respected. Fixes [#90](https://github.com/remorses/kimaki/issues/90).

3. **Fixed `kimaki send` thread creation race causing DiscordAPIError[160004]** — `kimaki send` posts a starter message then creates the thread via REST. A recent change accidentally caused the bot's GuildText handler to also try calling `startThread()` on the same message, triggering a "thread already created" error. The GuildText handler now skips messages with a start marker.

4. **Updated OpenCode SDK to 1.3.7** — picks up latest OpenCode improvements.

## 0.4.87

1. **New `/btw` command** — fork the current session into a new thread and immediately send a prompt, without replaying past messages:
   ```
   /btw prompt: why is the auth module structured this way?
   ```
   Useful for side questions or tangents without polluting or blocking the original thread. The forked thread inherits the full session context and starts working right away.

2. **Fixed slash command registration exceeding Discord's 100-command limit** — with many agents, skills, and MCP prompts, the total could exceed Discord's hard cap and cause registration errors. Dynamic commands are now registered in priority order (agents → user commands → skills → MCP prompts) and trimmed at 100. Three rarely-used static commands were removed to free slots: `stop` (duplicate of `/abort`), `memory-snapshot` (use `kill -SIGUSR1` instead), and `toggle-mention-mode`.

## 0.4.86

1. **Fixed voice messages getting lost when a question dropdown is pending** — sending a voice message while the AI's question dropdown is showing no longer discards the voice content. Previously, `message.content` (empty for voice) was passed as the question answer, sending `""` to the model, and the early-return prevented transcription from ever running. Now the empty-content message properly unblocks OpenCode's question waiter and flows through normal transcription, arriving as the next user message after the model responds.

## 0.4.85

1. **Fixed infinite reconnect loop after gateway proxy restart** — after a failed RESUME, the proxy now sends an `INVALID_SESSION` payload and properly drains the WebSocket sink before teardown, so the client reconnects cleanly instead of looping indefinitely.

2. **Fixed `ClientReady` errors crashing the bot silently** — unhandled rejections thrown inside the `ClientReady` handler are now caught and logged instead of taking down the process.

3. **Fixed slash commands being mirrored by external sync** — slash commands like `/errore-skill` dispatched from Discord were missing the `<discord-user />` origin tag (because `session.command()` doesn't accept synthetic text parts), causing external sync to treat them as external messages and mirror them as `» user: …`. The tag is now appended to command arguments so origin detection works correctly.

4. **Fixed Discord origin detection in command-argument text** — the origin metadata parser previously only matched the tag when it was the entire string (anchored `^…$`) and only looked in synthetic text parts. It now matches the tag anywhere in text and checks all text parts (synthetic first, non-synthetic as fallback).

## 0.4.84

1. **New `--projects-dir` flag** — set a custom directory where new projects are created:
   ```bash
   kimaki --projects-dir ~/my-projects
   ```
   Defaults to `<data-dir>/projects` if not set. The directory is created automatically if it doesn't exist.

2. **`kimaki tunnel --kill` flag** — kill any existing process on the port before starting the tunnel:
   ```bash
   kimaki tunnel --kill
   kimaki tunnel -k
   ```
   All tunnel usage examples in the system message and onboarding tutorial now include `--kill` so agents always free stale ports automatically.

3. **Screenshare links are now private by default** — `/screenshare` replies ephemerally, the default lifetime is 30 minutes, and tunnel IDs use 128-bit random values so leaked hosts are much harder to guess.

4. **Fixed queued messages getting stuck after question dropdown answered** — when a user answered a pending question via the Discord select menu, queued messages could stay stranded indefinitely. Queued items are now handed off to OpenCode immediately after the question reply instead of waiting for a separate idle event.

5. **Fixed external sync treating kimaki-initiated sessions as external** — the external sync poller was mirroring sessions owned by kimaki itself, creating duplicate `Sync:` threads. Detection now uses a pure event-based check (presence of `<discord-user />` in the latest user message) instead of a DB lookup, so it's accurate even when the DB entry hasn't been written yet.

6. **Fixed external sync missing Discord origin when message-id is absent** — bot-initiated threads weren't passing `sourceMessageId` to the ingress path, causing the origin parser to return null and mistakenly mirror those turns as `» user: hi`. Both the parser and the ingress call are now fixed.

7. **Fixed gateway reconnection crashes** — the forced gateway relogin mechanism was interfering with discord.js's own exponential-backoff reconnect logic, causing uncaught exceptions on handshake timeouts that killed the process. discord.js reconnection now handles recovery on its own.

## 0.4.83

1. **External OpenCode session sync** — kimaki now mirrors OpenCode sessions started outside Discord (e.g. from the CLI or another editor) into tracked Discord project threads automatically. Sessions are polled every 5 seconds, a new thread is created prefixed with `Sync:`, and messages stream in just like a normal kimaki session. Typing indicators show while the external session is busy.

2. **Two-way external sync** — replies sent in the synced Discord thread are forwarded back into the external OpenCode session. If you switch back to the CLI to continue a conversation, kimaki detects the new CLI-originated messages and re-claims the thread so sync keeps flowing.

3. **Live voice sessions switched to Gemini 2.0 Flash Live** — Discord voice sessions now use Google's latest lower-latency live audio model for faster, more natural conversations.

4. **Fixed scheduled thread prompts not triggering** — tasks scheduled against an existing thread were posted as bot messages that the bot's own-message guard was silently ignoring. Scheduled tasks now use the canonical start-marker path so they fire correctly.

5. **Fixed abort race before next message** — when a user sent a new message while a permission prompt was pending, the abort was fire-and-forget and the new message could race with the dying run. The abort now waits for `session.idle` (up to 2s) before the next message is enqueued.

6. **Suppressed notifications for intermediate queue steps** — permission prompts, question dropdowns, and footer messages now send silently when the thread queue has pending items. Only the final message in a queue notifies the user.

7. **SQLite cleanup on channel deletion** — deleting a Discord channel now removes all orphan rows (`channel_directories` and children) from the local SQLite database. `kimaki project list` no longer shows ghost entries, and a new `--prune` flag removes any remaining stale entries.

8. **Fixed OpenCode server restart on bot shutdown** — SIGINT was not suppressing the auto-restart loop, causing orphan OpenCode server processes to spawn after the bot exited. Both SIGINT and the `shuttingDown` flag now correctly suppress restarts.

## 0.4.82

1. **`/restart-opencode-server` now re-registers slash commands** — after restarting the OpenCode server, kimaki immediately re-registers all Discord slash commands (built-in + user commands + agents). New or changed commands, agents, and plugins are picked up without a full bot restart.
2. **Buttons and dropdowns stay alive for 24 hours** — permission prompts, question dropdowns, and file upload dialogs previously expired after 5 minutes (IPC stale TTL) and thread runtimes were disposed after 1 hour. Both are now 24 hours, so users who return the next day can still click pending buttons and selects.

## 0.4.81

1. **Fixed bot ignoring worktree and bot-created threads** — threads created by `/new-worktree`, `/fork`, or `kimaki send` were silently ignored because the thread guard (GitHub #84) checked for a non-empty session ID in the DB, but `createPendingWorktree` writes an empty `session_id`. The bot now also checks `thread.ownerId` — if the bot created the thread, it always responds.
2. **New `/memory-snapshot` command** — write a V8 heap snapshot to disk on demand for debugging memory issues. The snapshot is saved to `~/.kimaki/heap-snapshots/`.
3. **Fixed Anthropic OAuth token exchange race** — moved OAuth token exchange and refresh to an isolated Node helper to avoid 429 rate-limit responses and duplicate token exchanges when the browser callback lands.
4. **Fixed OOM from unbounded `session.diff` event strings** — `session.diff` events carrying large patch payloads are now dropped from the event buffer, and all buffered event strings are recursively pruned to a safe max length.

## 0.4.80

1. **Built-in Anthropic OAuth authentication** — the Anthropic OAuth plugin now ships with kimaki and loads automatically. No need to manage a separate plugin file in `~/.config/opencode/plugins/`. Log in with `/login` → Anthropic → OAuth and kimaki handles the PKCE flow, token refresh, and Claude Code request rewriting.

2. **New `kimaki task edit` CLI command** — edit the prompt and/or schedule of a planned task without deleting and recreating it:
   ```bash
   kimaki task edit <id> --prompt "Updated task description"
   kimaki task edit <id> --send-at "tomorrow at 9am"
   kimaki task edit <id> --prompt "New prompt" --send-at "every day at 8am"
   ```
   Only works on tasks in `planned` state.

3. **New `kimaki session discord-url` CLI command** — print the Discord thread URL for a given OpenCode session ID:
   ```bash
   kimaki session discord-url <session-id>
   kimaki session discord-url <session-id> --json
   ```
   `--json` returns `{ url, threadId, guildId, sessionId, threadName }` for scripting.

4. **Paginated select menus for `/model` and `/login`** — Discord caps select menus at 25 options, silently dropping anything beyond that. Providers like OpenRouter expose 162+ models, making many unreachable. Select menus now paginate with "← Previous page" / "Next page →" navigation so all providers and models are accessible.

5. **Fixed `/redo` to step forward one message at a time** — previously `/redo` jumped all the way back to the latest state in one shot. It now matches OpenCode TUI behavior: each `/redo` moves one user message forward (symmetric with `/undo`), so 3 undos require 3 redos to fully restore.

6. **Fixed OOM crash during long sessions** — assistant `message.updated` events were passing through the event buffer uncompacted, each carrying the full cumulative parts array (all tool outputs and text). With 1000 buffer entries, memory could exceed 4GB and trigger a V8 OOM kill. The buffer now strips `parts`, `system`, `summary`, and `tools` from all message events, keeping only the lightweight metadata needed for derivation.

7. **Fixed voice attachment detection and empty prompt guard** — improved detection handles cases where Discord omits `contentType` on uploaded audio files (checks duration, waveform, and file extension as fallbacks). Added a guard to skip sending empty prompts when voice transcription fails or produces no text.

8. **Fixed prompt.md wrapping in Discord file preview** — long-line prompts sent as file attachments are now word-wrapped at 120 chars before upload, so Discord's file viewer renders them readably instead of requiring horizontal scrolling.

9. **Fixed `/undo` and `/redo` error handling** — SDK errors on `session.get` and `session.messages` calls now bail early with the error message instead of silently proceeding with wrong behavior.

## 0.4.79

1. **New `/tasks` command** — list and cancel scheduled tasks created with `kimaki send --send-at`:
   ```
   /tasks        — show active scheduled tasks with Cancel buttons
   /tasks --all  — include completed and failed tasks
   ```
   Each row shows the task's schedule, next run time, status, and a Cancel button for active tasks.

2. **New `--permission` flag for `kimaki send`** — restrict which tools an OpenCode session can use on a per-send basis:
   ```bash
   kimaki send 'Fix the bug' --permission 'bash:deny'
   kimaki send 'Review only' --permission 'edit:deny' --permission 'write:deny'
   kimaki send 'Run tests'   --permission 'bash:git *:allow'
   ```
   Format is `tool:action` or `tool:pattern:action`. Rules are appended after base permissions so they take priority.

3. **Fixed `/undo`** — now correctly aligns with OpenCode's TUI behavior. Passes the last user message ID (not the assistant message ID) to `session.revert()`, and removes manual message deletion — cleanup happens automatically on the next prompt.

4. **Fixed error replies now trigger Discord notifications** — error messages from failed sessions, permission denials, and voice errors were using silent flags and easy to miss. They now send proper Discord notifications.

5. **Fixed bot responding to non-kimaki threads** — the bot was processing all threads in configured project channels, including user-created threads with nothing to do with kimaki. It now ignores threads that don't have an existing session unless explicitly @mentioned.

6. **Fixed `/login` code-mode OAuth** — when a provider returns `method="code"` (e.g. SSH-based flows), a "Paste authorization code" button now appears so users can complete the flow. Previously the context was deleted immediately, making code mode a dead end.

7. **Fixed queue messages not dispatching when action buttons are shown** — queued messages now dispatch immediately when the session becomes idle, even if action buttons are still visible. Previously the queue was blocked unnecessarily while buttons were on screen.

8. **Fixed cron task timezone** — cron schedules (e.g. `0 10 * * *`) are now always evaluated in UTC, matching what the system message tells the model. Previously they fired at the machine's local time, which was wrong when the server is in a different timezone.

9. **Startup time ~40% faster** — three optimizations reduce time-to-ready: OpenCode health poll interval dropped from 1000ms to 100ms, the OpenCode server now starts earlier (overlapping with Discord login), and `which opencode` / `which bun` checks run in parallel.

10. **Fixed `/login` error messages and stale context cleanup** — consistent error parsing across all login steps, and pending login contexts are now cleaned up on failure instead of lingering until TTL.

## 0.4.78

1. **New `/screenshare` command** — share your screen via noVNC directly in the browser. Works on macOS (uses built-in Remote Management) and Linux (spawns x11vnc):
   ```
   /screenshare        — start screen sharing, bot replies with a noVNC URL
   /screenshare-stop   — stop the active session
   ```
   Also available as `kimaki screenshare` from the CLI (runs until Ctrl+C). Sessions auto-stop after 1 hour. One active session allowed per guild. The in-process websockify bridge replaces the Python websockify dependency — no extra installs needed.

2. **Fixed plugin part IDs failing OpenCode validation** — OpenCode requires all part IDs to start with `prt_`. The plugin hooks (MEMORY.md injection, time-gap notice, memory save reminder, git branch injection, onboarding tutorial) were generating bare UUIDs, causing a ZodError at runtime. All five are now correctly prefixed.

3. **Fixed screenshare tunnel not cleaning up on connect failure** — if the tunnel failed to connect or timed out, the `TunnelClient` kept trying to reconnect in the background. It is now explicitly closed on error so no orphaned reconnect loops are left running.

4. **Fixed screenshare startup on Linux** — replaced a blind 1-second sleep after spawning x11vnc with a port-readiness poll (100ms interval, 3s max). The startup now fails immediately if x11vnc exits early instead of hanging.

## 0.4.77

1. **Fixed session hang after dismissing permission prompts** — when a user sent a new message while a permission prompt was blocking a previous run, the blocked run would hang indefinitely. Now pending permission requests are rejected immediately when a new message arrives, so the follow-up can proceed without waiting.

2. **`kimaki` available as a direct command inside OpenCode sessions** — agents can now call `kimaki` directly (without `npx` or `bunx`) inside OpenCode sessions. A small cross-platform shim is injected into the server PATH so `kimaki session archive`, `kimaki user list`, etc. work the same way regardless of whether kimaki was launched via a global install, npm, pnpm, or a transient npx/bunx invocation.

3. **Fixed selected model lost after interrupt/resume** — when a session was interrupted mid-run (e.g. via `/model` switch) and then resumed, the resumed run fell back to the default model instead of the user's selection. The interrupt plugin now captures and carries the chosen agent/model into the resume call.

4. **Fixed Windows opencode startup** — `where opencode` output is now normalized before picking a binary so Windows installs prefer npm shim paths over raw non-executable entries or multiline `OPENCODE_PATH` values. `.cmd` launches are routed through `cmd.exe` with `windowsVerbatimArguments` for correct argument quoting on Windows.

5. **Fixed voice message transcription for m4a/mp4 audio** — audio MIME values including m4a aliases are now normalized before provider handling. m4a files are transcoded to WAV via ffmpeg for OpenAI `input_audio` compatibility, while OGG/Opus conversion continues on its own path.

6. **Fixed opencode `tool-output` directory access** — the `tool-output` directory (used by opencode for file outputs) is now allowed by default so agents can write outputs without hitting permission errors.

## 0.4.76

1. **SSE wire format for programmatic gateway events** — `kimaki --gateway` in headless/non-TTY mode now emits events using the SSE wire format (`data: {...}\n\n`) instead of bare JSON lines. This lets consumers use the `eventsource-parser` npm package to reliably extract events even when log noise, warnings, or spinner output is interleaved on stdout:
   ```ts
   import { createParser } from 'eventsource-parser'
   const parser = createParser((event) => {
     if (event.type === 'event') {
       const e = JSON.parse(event.data) // ProgrammaticEvent
     }
   })
   // pipe kimaki stdout chunks into parser.feed(chunk)
   ```
   The event shape is unchanged (`install_url`, `authorized`, `ready`, `error`).

2. **Default channel and welcome message created in headless mode** — when spawning `kimaki --gateway` programmatically (non-TTY), the default `#kimaki` channel and onboarding welcome thread are now created automatically after the bot connects, matching what the interactive setup flow does.

3. **Fixed gateway `--gateway-callback-url` redirect** — the `--gateway-callback-url` CLI option was silently ignored: the OAuth callback hook returned a double-wrapped response object instead of a `302 Response`, so users always landed on `/install-success` regardless of the custom URL.

4. **Fixed question tool duplicate prompt on text answer** — when the model used the question tool and the user replied with a plain text message instead of using the dropdown, the message was sent both as a question answer and as a new prompt, causing repeated abort/retry cycles. Text answers now skip the re-enqueue path.

5. **Fixed question tool TTL expiry behavior** — when the 10-minute timeout expired on a pending question, the bot was sending `['Other']` as a fake answer — causing the model to act on a choice the user never made. On expiry it now aborts the session silently without faking a selection.

6. **Fixed race between question dropdown click and session abort** — deleting the pending question context before calling `session.abort()` prevents a late dropdown click during the async abort from being accepted and then immediately killed.

7. **More punctuation supported in `. queue` suffix** — `!`, `?`, `,`, `;`, `:` are now accepted before `queue` in addition to `.`, and a trailing period is optional. Patterns like `Fix the bug! queue` or `Do this? queue.` now work.

## 0.4.75

1. **Default Kimaki channel created on onboarding** — a `kimaki-{botName}` channel (or `kimaki` in gateway mode) is now automatically created in the Kimaki category for general-purpose tasks. It's not tied to a project — the backing directory is `~/.kimaki/projects/kimaki`, initialized with git. Idempotent: skipped if the channel already exists.

2. **Welcome message and onboarding tutorial** — the default channel gets a welcome message on first creation explaining what Kimaki is. Sending your first message triggers a built-in tutorial that guides you through building a 3D Space Dodge game with Three.js + kimaki tunnel.

3. **Non-TTY gateway mode with JSON event protocol** — `kimaki --gateway` now works in headless environments (cloud sandboxes, CI, Docker). Instead of interactive prompts, it emits structured JSON lines:
   ```json
   {"type":"install_url","url":"..."}
   {"type":"authorized","guild_id":"..."}
   {"type":"ready","app_id":"...","guild_ids":[...]}
   {"type":"error","message":"..."}
   ```
   This makes it easy to script gateway onboarding without a terminal.

4. **`kimaki bot` command group** — new CLI subcommands to manage bot presence:
   ```bash
   # set bot status
   kimaki bot status set "Working on your code" --type playing --status online

   # clear bot status
   kimaki bot status clear

   # print bot install URL
   kimaki bot install-url
   ```
   Note: status commands are blocked in gateway mode since presence is global (shared bot).

5. **`/model-variant` command** — quickly switch the thinking level for the current model without going through the full `/model` menu. Shows variant and scope pickers in a single reply.

6. **`/mcp` command** — list and toggle MCP servers for the current project:
   - Shows all configured MCP servers with their status (connected/disconnected/error)
   - Select a server from the dropdown to connect or disconnect it

7. **`. queue` suffix support** — append `. queue` to any regular text message to queue it for after the current session finishes, same as the `/queue` command:
   ```
   Fix the login bug. queue
   ```

8. **Queue drains after session errors** — messages stuck in the local queue are now dispatched even if the session ended with an error, preventing stuck voice transcriptions.

9. **Worktree action buttons in `/worktrees` table** — delete buttons now appear directly in the worktrees table rows. Force-remove works even when the worktree folder contains submodules. Base and target branch autocomplete added to worktree commands.

10. **Footer anchored to assistant completion** — the run footer (`kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ ...`) is now sent immediately after the last text part instead of being delayed, preventing spurious footers from appearing after interruptions.

11. **Runtimes reconnect after shared server restart** — `/restart-opencode-server` now properly reconnects all active thread runtimes after the server comes back up.

12. **Common directories pre-allowed for permissions** — system paths like `~/.npm`, `~/.cargo`, `/tmp`, and similar build caches are automatically allowed at the guild level, reducing permission prompts for common tool operations.

13. **Voice `[inaudible audio]` for incomprehensible input** — very short or inaudible voice messages now return `[inaudible audio]` instead of triggering a transcription error.

14. **`--gateway-callback-url` CLI option** — customize the OAuth redirect URL after bot authorization, useful for self-hosted website deployments.

15. **Memory leak fixes** — comprehensive cleanup of runtime and pending-UI state when sessions end, preventing accumulation of stale state across long-running bot processes.

## 0.4.74

1. **`kimaki session archive` and `kimaki user list` CLI commands** — Discord REST operations previously done by plugin tools (`kimaki_archive_thread`, `kimaki_list_discord_users`) are now proper CLI subcommands. The plugin tools were silently broken in gateway mode because they had no way to route requests through the proxy:
   ```bash
   # archive a thread by session ID
   kimaki session archive --session ses_abc123
   # list Discord users in the guild (with optional search)
   kimaki user list --guild 123456789 --query alice
   ```
   `kimaki_mark_thread` was removed (unused). The plugin no longer receives `KIMAKI_BOT_TOKEN`, eliminating the credential leak into child processes.

2. **Fixed `kimaki send` failing with 401 in gateway mode** — `resolveBotCredentials` now reads from the database first (which correctly sets the gateway proxy URL), falling back to the `KIMAKI_BOT_TOKEN` env var only for headless/CI deployments. Previously, subcommands always sent credentials directly to discord.com instead of through the proxy.

3. **Fixed bot mode selection for subcommands** — `send`, `project list`, `upload-to-discord` and other short-lived subcommands now correctly detect whether gateway or self-hosted mode is active. The fix uses a persistent `last_used_at` timestamp on the bot token row that the main bot stamps at startup, giving cross-process subcommands a reliable source of truth without any in-memory flags.

4. **Fixed queued message interrupt timing** — queued follow-up messages now abort as soon as the current assistant turn hits a blocking step-finish, instead of waiting for a hard timeout. The interrupt plugin also correctly waits for the aborted assistant message to propagate before resuming, preventing race conditions where resume could fire before abort was fully settled.

5. **Fixed empty resume messages appearing as queued work** — the interrupt plugin's internal `promptAsync({ parts: [] })` resume calls are no longer mistakenly tracked as pending user messages.

6. **Worktree creation more resilient to broken submodule configs** — partially-removed submodules (deleted from the tree but still referenced in `.gitmodules`) no longer block worktree creation; the error is logged as a warning and the worktree is returned normally.

7. **`/worktrees` capped at 10 entries** — keeps the ephemeral response compact when many worktree sessions have accumulated.

## 0.4.73

1. **New `/worktrees` slash command** — list all active worktree sessions with branch, status, and age; handles deleted worktree folders gracefully
2. **New `/stop-opencode-server` command** — manually stop the OpenCode server for the current project channel
3. **OpenCode servers auto-stop after 2 hours of inactivity** — idle server processes are cleaned up automatically to free resources
4. **Agent name shown in thread messages** — messages now prefix with the active agent name (e.g. `[build-agent]`) instead of the generic `task` label
5. **Tool calls from previous sessions hidden** — resuming a session no longer replays tool call messages from earlier runs in the thread
6. **Stale action buttons cleaned up** — action buttons left over from ended sessions are properly removed
7. **Legacy global slash commands removed on startup** — outdated global commands are automatically cleaned up when the bot registers guild commands
8. **`--gateway` CLI flag** — force gateway mode even when self-hosted credentials are already saved, useful for switching between modes
9. **`/login` providers sorted by popularity** — most-used providers (Anthropic, OpenAI, etc.) are listed first
10. **`/verbosity` uses a dropdown** — replaced text input with a select menu for a better UX when setting output verbosity
11. **Fixed duplicate context usage notices** — context percentage no longer appears twice before the run footer
12. **Fixed queued message delivery timing** — queued messages now wait for the current run to fully complete before dispatching
13. **Bot explains unlinked channels** — when `@mentioned` in a channel not linked to a project, the bot now sends a helpful explanation
14. **Fixed typing indicator stuck after `/abort`** — typing indicator now properly clears when aborting a session
15. **Fixed interrupt messages showing `»` prefix** — messages after an abort no longer show the queue indicator prefix
16. **`/queue` confirmation delayed until dispatched** — queue echo is shown only after the message is actually placed in the queue
17. **Voice messages show queue position** — queued voice messages now display their queue position number
18. **`~/.kimaki` always accessible** — OpenCode sessions no longer trigger permission prompts when reading kimaki config files
19. **Smart bot auto-selection** — picks the correct bot configuration automatically when multiple bots are configured in the database
20. **`--restart-onboarding` flag renamed from `--restart`** — more descriptive name for the flag that re-runs the setup wizard

## 0.4.72

1. **Fixed plugin tools silently missing** — `kimaki_action_buttons`, `kimaki_file_upload`, `kimaki_mark_thread`, and other plugin tools were silently missing on some OpenCode versions due to a crash in the plugin loader; the root cause (an extra exported function confusing the loader) is now fixed
2. **Voice "queue this message" intent** — say "queue this message" (or similar) in a voice note while the AI is working and the message is queued instead of interrupting the current session
3. **Voice reliability fixes** — three race conditions fixed: active-session state is now snapshotted at message arrival so voice messages queue correctly even if the previous task finishes during transcription; transcription failures no longer send empty prompts; the "queued" label is only shown after the actual queuing decision
4. **Log file now at `~/.kimaki/kimaki.log`** — logs are written in all environments (was only written in dev mode before); the AI model is also told where to find the file for self-diagnosis
5. **Secrets scrubbed from logs and error reports** — API keys, Bearer tokens, and other credentials are now redacted from log output and Sentry payloads; non-sensitive identifiers like Discord IDs and channel names are preserved for debugging
6. **Fixed Discord permission checks for uncached members** — member role/permission lookups now handle both cached class instances and raw API payload shapes, fixing permission errors for users whose data wasn't in the bot's cache (thanks @ajoslin in #57)
7. **Fixed atomic worktree database writes** — worktree state is now written atomically to prevent rare race conditions (thanks @ajoslin in #58)
8. **New built-in skills: `simplify`, `batch`, `security-review`** — three skills extracted from Claude Code CLI are now available to the AI agent in every Kimaki session

## 0.4.71

1. **Fixed package.json dependency classification** — `opencode-deterministic-provider` moved from `dependencies` to `devDependencies` so it no longer appears as a runtime dependency in the published package

## 0.4.70

1. **Immediate interrupt handling** — sending a new message while the AI is working now aborts the running session at the next step boundary, so your follow-up is processed right away instead of waiting for the full response to finish
2. **Memory simplified to `MEMORY.md`** — the `--memory` flag and Discord forum-based memory infrastructure are removed; the agent now reads and updates a `MEMORY.md` file in your project root automatically, with no flags or setup required
3. **Agent descriptions in system prompt** — all configured agents and their descriptions are now injected into the session context so the AI can make smarter agent selection decisions
4. **Slash command name fixes** — user-defined commands containing slashes, colons, or other special characters now register and route correctly in Discord
5. **Voice transcription reliability** — voice messages are now processed in the correct order; the transcription model no longer accidentally answers user questions; stale transcriptions from previous sessions are no longer reused
6. **Worktree creation fixes** — worktree creation no longer fails due to broken dependency install steps (`ni` and `--frozen-lockfile` removed)
7. **Fork dropdown filtering** — the `/fork` message picker no longer shows internal synthetic messages, only real user and assistant turns
8. **Large tool output truncation** — tool call outputs exceeding 30k characters are truncated to prevent context window overflow during session reads
9. **Permission prompt suppression** — the agent no longer triggers permission prompts when accessing `MEMORY.md` and other config paths

## 0.4.69

### Patch Changes

- feat: **OpenAI voice transcription** — new `/transcription-key` command stores API key for voice message transcription; auto-detects provider from key prefix (`sk-*` → OpenAI, otherwise Gemini)
- feat: **`gpt-4o-audio-preview` transcription model** — uses the chat completions API with OGG-to-WAV conversion for high-quality voice-to-text; falls back gracefully on decode errors
- feat: **in-process Hrana v2 server** — replaces the 39 MB `sqld` Rust binary with a lightweight Node.js HTTP server speaking the [Hrana v2 protocol](https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md), backed by `libsql`; eliminates a large binary dependency and startup overhead
  ```
  Before: sqld child process (39 MB Rust binary)
  After:  in-process HTTP server on the lock port — same Prisma adapter, no separate process
  ```
- feat: **bot-to-bot sessions** — bots with the Kimaki role can now trigger OpenCode sessions; a self-message guard prevents infinite loops when the bot also has the Kimaki role
- feat: **action button TTL extended to 24 hours** — buttons no longer expire after 30 minutes, so late replies to pending confirmations still work
- feat: **auto-derive App ID from bot token** — no interactive prompt needed; when `KIMAKI_BOT_TOKEN` is set the App ID is extracted automatically
- feat: **thread ID in system prompt** — `threadId` is now injected into the OpenCode system prompt so agents can reference the current Discord thread for scheduling reminders (`--send-at`)
- feat: **termcast skill** — new built-in skill for building Raycast-style TUIs with React in the terminal via `termcast`/`opentui`
- feat: **memory forum auto-tags** — project tags are created automatically on the memory forum channel; embeds are suppressed in forum messages for cleaner appearance
- fix: **remove `/upgrade-and-restart` command** — the command caused confusion and is no longer needed (fixes #49)
- fix: **`/login` and `/model` dropdowns sorted** — provider and model options are now sorted alphabetically for easier scanning
- fix: **archive thread delay** — increased from 5 s to 10 s so the final bot message is readable before the thread hides from the sidebar
- fix: **project channel footer** — footer now survives the Discord 2000-char limit and falls back gracefully on empty body
- fix: **test isolation** — vitest runs now auto-isolate from the real `~/.kimaki/` database via `KIMAKI_VITEST` env var injected by `vitest.config.ts`
- fix: **`waitForServer` simplified** — all scripts now poll only `/api/health` (matching `opencode.ts`) and use `127.0.0.1` to avoid DNS/IPv6 ambiguity

## 0.4.68

### Patch Changes

- feat: **`kimaki_action_buttons` tool** - AI can now show Discord buttons for quick confirmations; buttons are dismissed automatically when user sends a new message
- feat: **persistent memory** - `--memory` flag enables a project-scoped memory folder synced as a Discord forum channel, with system prompt instructions injected each session
- feat: **global memory scope** - memory forum threads can be tagged as global to share context across all projects
- feat: **scheduled tasks** - `kimaki send --send-at` allows scheduling messages to run at a future UTC time, with cron-style recurring tasks supported
- feat: **forum markdown sync engine** - bidirectional sync between Discord forum channels and local markdown files, replacing `forum-sync.json` with SQLite-backed config
- feat: **session origin tracking** - track where sessions were started (slash command, message, scheduled task, etc.) for better diagnostics
- feat: **project list improvements** - `kimaki project list` now shows Discord channel name and folder name
- fix: **action button rendering** - render action buttons after stream flush and hide tool call output during button wait
- fix: **agent/model preference snapshots** - correctly snapshot thread agent and model preferences at session start
- fix: **archive-thread race** - parallelize footer async calls to eliminate archive-thread race condition
- fix: **session idle race** - resolve deferred session idle race in interactive flows (permissions, questions, file uploads)
- fix: **worktree parent row** - ensure `thread_sessions` parent row exists before creating worktree child row
- fix: **file attachments in bot-initiated threads** - read file attachments correctly when thread is started by the bot
- fix: **resume stuck forever** - fix `/resume` command getting stuck on "Loading N messages..." indefinitely
- fix: **interactive UI echo** - prevent user messages from being echoed back when flushing interactive UI state
- fix: **duplicate part output** - prevent duplicate part output on interrupted/replayed runs
- fix: **send-at UTC format** - require explicit UTC date format for scheduled task timestamps
- fix: **startup timeout errors** - include opencode stderr tail in startup timeout error messages for easier debugging
- perf: **non-blocking quick-start** - bot startup is now non-blocking so the ready message appears faster

## 0.4.67

### Patch Changes

- feat: **`/session-id` command** - new slash command shows current session ID and `opencode attach` command to connect directly from terminal
- fix: **harden opencode plugin hooks** - wrap `chat.message` and `event` hooks in `errore.tryAsync` to prevent unhandled rejections from crashing the plugin; log warnings instead
- fix: **file upload timeout** - replace `AbortSignal.timeout()` with explicit `AbortController` + `errore.tryAsync` for cleaner error handling in `kimaki_file_upload` tool
- fix: **suppress embed previews** in `/model` confirmation replies to avoid noisy link unfurls
- fix: **label voice transcriptions** - prepend `Voice message transcription from Discord user:` prefix so the model understands the message origin
- fix: **`/context-usage` format** - show percentage first (`95%, 12,345 / 13,000 tokens`) for quicker scanning
- docs: **`kimaki tunnel` help** - clarify that custom `--tunnel-id` is only safe for services meant to be public
- chore: **update tuistory skill** guidance from upstream
- chore: **bump traforo submodule** after Retry-After fix

## 0.4.66

### Patch Changes

- feat: **session search command** - add `kimaki session search <query>` CLI command to search past conversations with text or regex patterns
- feat: **plugin branch detection** - inject synthetic parts showing current branch and branch changes mid-session
- feat: **plugin idle-time awareness** - inject timestamp parts when >10min elapsed between messages
- feat: **skill tool visibility** - show skill invocations (playwriter, tuistory, jitter) in essential tools verbosity mode
- feat: **verbose OpenCode server flag** - add `--verbose-opencode-server` to forward server logs to kimaki.log for debugging
- feat: **skills infrastructure** - sync-skills script clones and discovers skills from remote repos, add skills paths to OpenCode config
- feat: **V8 heap snapshots** - inject `--heapsnapshot-near-heap-limit=3` to catch OOM crashes before SIGKILL
- feat: **CLI upgrade restart** - `kimaki upgrade` now automatically restarts the running bot after upgrading
- fix: **read-only explore permissions** - prevent explore subagents from inheriting global allow rules for edits and bash
- fix: **typing indicator lifecycle** - clear delayed typing restarts on session cleanup to prevent zombie typing
- fix: **detached git state warnings** - detect detached HEAD and detached submodule states in branch context
- fix: **message content truncation** - truncate unbounded error messages and AI text to prevent Discord API errors (fixes #38)
- fix: **archive delay** - increase from 3s to 5s so final messages are read before thread hides
- refactor: **migrate to SDK v2** - complete migration from @opencode-ai/sdk v1 to v2 flat parameter convention
- chore: **increase bash inline threshold** - raise from 50 to 100 chars for better command visibility
- chore: **bump errore to 0.12.0** - includes cleanup/cancellation docs and SuppressedError handling
- docs: add **traforo comprehensive guide**, essential tools filtering reference, plan-first guidance for cross-project prompts

## 0.4.65

### Patch Changes

- feat: **store model variant** in model tables with session/channel/global cascade for thinking level preferences
- perf: **parallelize session-handler** async operations for faster session initialization
- fix: **guard against non-hydrated guild members** in permission check to prevent crashes
- fix: **parallelization bugs** in session-handler affecting concurrent operations
- fix: **keep /fork customId under 100 chars** to comply with Discord's custom_id length limit
- fix: **remove decimal digits** from session duration in footer for cleaner display
- refactor: **replace deprecated ephemeral: true** with MessageFlags.Ephemeral
- style: **run oxfmt formatter** across src for consistent code style
- docs: add **tool permissions section** to README
- docs: clarify **--thread vs --session** usage
- docs: document **long --wait timeout** + fallback behavior
- docs: warn about **Discord custom_id length limit** in agents instructions

## 0.4.64

### Patch Changes

- feat: **search across all projects** in `kimaki session read` when session not found in current project
- feat: add **--no-critique flag** to disable automatic diff uploads to critique.work (addresses #37)
- fix: **improved Discord markdown rendering** - prevent list/code block concatenation that breaks Discord parsing
- fix: **silently remove permission buttons** on auto-reject instead of sending warning message
- fix: **abort all active sessions** before restarting OpenCode server to prevent orphaned requests
- refactor: **rely on marked AST** for list/code formatting instead of regex splitting

## 0.4.63

### Patch Changes

- fix: **pin Prisma to 7.3.0** to avoid startup crash in fresh installs (Prisma 7.4.x `reading 'graph'`)
- fix: **print stack traces** for unhandled errors and Prisma init failures to make install-time crashes debuggable
- fix: **avoid echoing shell command args** back into the channel
- fix: **remove expired permission messages** by silently removing buttons
- refactor: **remove Vercel AI SDK tool helper dependency** (keep a minimal local tool definition)
- style: use `*italic*` instead of `_italic_` in session completion messages

## 0.4.62

### Patch Changes

- feat: **show project folder and git branch** in session completion message for better context
- feat: **unify /model scope selection** for threads and channels - consistent UX
- feat: **enable SQLite WAL mode** with busy_timeout for better concurrency
- fix: **hide session cost line** in /context-usage when cost is zero

## 0.4.61

### Patch Changes

- feat: add **/context-usage** slash command to show token usage and context window percentage
- feat: add **/queue-command** slash command for queuing user commands
- feat: add **--wait flag** to `kimaki send` command
- feat: add **open-in-discord** subcommand to `kimaki project`
- feat: **improve quick agent command replies** with context and validation
- perf: **speed up agent quick commands** by skipping OpenCode server check
- fix: **show context percentage** for large tool outputs
- fix: **snapshot model and agent** at message arrival to prevent race conditions with `/agent` command
- fix: **fail fast** on invalid session agent
- refactor: **remove context usage breakdown** line from `/context-usage` command

## 0.4.60

### Patch Changes

- feat: **show current agent** in /agent command reply
- fix: **harden schema migration** SQL parsing to prevent startup crashes on malformed SQL
- fix: **keep only error reaction** on thread messages to reduce visual noise
- refactor: **reuse thread archive flow** in CLI and plugin for consistent behavior
- chore: **migrate CLI parser** to goke for better argument handling

## 0.4.59

### Patch Changes

- feat: **render tables as Discord Components V2** instead of code blocks for better readability
- feat: move session **list/read commands to CLI** (`kimaki session list`, `kimaki session read`) to save token usage
- feat: rename **add-project** CLI references to **project add**
- style: simplify **table keys** to bold only

## 0.4.58

### Patch Changes

- fix: **inline `tool()` helper** to avoid `@opencode-ai/plugin/tool` subpath import that fails in global npm installs (fixes #35)
- fix: remove double newlines from permission request messages
- fix: remove **opencode version check** at startup (replaced by background auto-upgrade)
- feat: **auto-upgrade opencode** in background on bot startup
- chore: update opencode deps to 1.1.53

## 0.4.57

### Patch Changes

- fix: move **@opencode-ai/plugin** from devDependencies to dependencies so it's available in global installs (fixes #35)
- feat: add **opencode version check** at startup - exits with clear message if installed opencode is older than 1.1.51
- feat: add **`project` subcommands** - `kimaki project list`, `kimaki project create`, `kimaki project add` (alias for `add-project`)
- feat: **`send` defaults to cwd** when neither `--channel` nor `--project` is provided
- feat: add **cross-project commands** documentation in system message
- fix: **strip mentions from thread titles** so `<@123>` doesn't appear in thread names
- fix: check **mention mode before permissions** to avoid sending permission errors to users who just didn't @mention the bot
- fix: `add-project` exits with **non-zero code** when channel already exists

## 0.4.56

### Patch Changes

- feat: add **emoji reactions** for thread marking (✅ for completion, 🌳 for worktrees)
- feat: add **archive thread** tool to close threads and remove them from Discord sidebar
- feat: add **/diff** command to view and share git diffs via web interface
- feat: enhance **permission buttons** with better styling (Success/Secondary/Danger)
- feat: change **default verbosity** to `text-and-essential-tools` to reduce noise
- fix: **resolve Discord mentions** to usernames in prompts and thread titles
- fix: skip logging **abort errors** as they are expected behavior
- fix: ensure **permission buttons** work correctly by removing dead code
- fix: proper handling of **thread closing** with timeouts

## 0.4.55

### Patch Changes

- feat: migrate database to **Prisma** for type-safe queries and better schema management
- fix: restore **idempotent schema** initialization to ensure database consistency on startup
- refactor: add **foreign key relations** to database schema

## 0.4.54

### Patch Changes

- feat: add **--domain** flag to tunnel command (defaults to `kimaki.xyz`)
- update **traforo** dependency with parametrizable base domain support

## 0.4.53

### Patch Changes

- feat: add **/login** command to authenticate with AI providers
- feat: show **current model info** in `/model` command response
- feat: show **task agent** name in Discord status/messages
- feat: add **worktree toggle** instead of enable/disable commands
- fix: **filter bash tools** by side effects to prevent accidental execution
- refactor: switch to **@xmorse/cac** for CLI parsing and add **npx kimaki tunnel** command
- refactor: consolidate resume commands to **/resume**

## 0.4.52

### Patch Changes

- feat: include **Discord CDN URLs** for image attachments in prompts so agents can fetch images if needed
- feat: always pass **explicit model** to OpenCode like TUI does for consistent behavior
- fix: check **config.model** before recent models for default model selection
- fix: add **suggestion to use CLI** for unlisted projects in add-project command
- update **errore** submodule

## 0.4.51

### Patch Changes

- feat: add **no-kimaki role** to block users from bot access even with owner/admin permissions (thanks @TotalLag for the suggestion)
- feat: disable **voice channels by default**, add `--enable-voice-channels` flag to opt-in

## 0.4.50

### Patch Changes

- feat: add **text-and-essential-tools** verbosity level - shows text + edits + custom MCP tools, hides read/search/navigation
- fix: **image handling** - send images as base64 data URLs with resizing, don't embed in prompt text
- fix: add **HEIC support** for image attachments

## 0.4.49

### Patch Changes

- fix **bracketed paste mode** causing setup to loop on macOS iTerm2 (thanks @ariane-emory for reporting)

## 0.4.48

### Patch Changes

- feat: add **discord username prefix** to AI prompts and ignore non-bot mentions
- feat: make **verbosity apply mid-session** and add `--verbosity` default flag
- fix: **gate session idle completion** to prevent premature session ends
- fix: **show apply_patch file names** from input instead of output
- fix: **filter hidden agents** from new-session autocomplete
- fix: **handle permission requests** from subtask sessions
- fix: log ignored errors and gate idle abort
- refactor: simplify waitForServer to check single health endpoint
- refactor: createNewProject extraction
- update **@clack/prompts** to latest

## 0.4.47

### Patch Changes

- add **/compact** command to trigger session context compaction
- add **caffeinate** spawn on macOS to prevent system sleep during sessions
- add **rate limit status** display in Discord when OpenCode is retrying
- add **apply_patch tool** display like edit with square icon and file summary
- add **uncommitted changes transfer** to worktree when using /new-worktree in threads
- fix **subtask separator** - use ⋅ and fix double spaces in tool output
- fix **stale session.idle events** ignored before content received
- fix **apply_patch tool** summaries defensive handling
- fix **abort reason** - pass Error to .abort() to prevent string leaking
- fix **whitespace normalization** in tool call arguments for Discord display
- fix **question tool answer** - send user message instead of 'cancelled'
- fix **blank lines** removed from command response messages
- refactor **log prefixes** shortened to max 8 chars with LogPrefix enum and picocolors

## 0.4.46

### Patch Changes

- fix **subtask output** hidden in text-only verbosity mode (thanks @xHeaven for reporting)
- fix **add users to threads** so they appear in sidebar
- fix **serialize discord event handlers** to prevent race conditions

## 0.4.45

### Patch Changes

- add **/verbosity** command for text-only mode toggle
- add **/new-worktree** support for existing threads
- fix **queued messages** sent after session completion
- fix **add-project --guild** flag for large Discord IDs
- fix **dedupe permission dropdowns** to prevent duplicate prompts
- fix **markdown chunk splitting** to prevent exceeding Discord limit
- refactor session event flow to use **errore** typed errors
- refactor **channel config** from XML topic to SQLite storage

## 0.4.44

### Patch Changes

- fix **send auto-start race condition** - use embed marker instead of database lookup
- add **/merge-worktree** command to merge worktree branch into main with ⬦ thread prefix
- add **/toggle-worktrees** command for channel settings
- add **--use-worktrees** flag for automatic worktree creation on new sessions
- add **add-project** CLI command with worktree submodule/deps init
- fix **merge-worktree** non-fast-forward handling, uncommitted changes check, detached HEAD support

## 0.4.43

### Patch Changes

- feat: handle **2000 char limit** in send command with automatic splitting
- fix: track **multiple pending permissions** per thread to prevent duplicates and hangs
- update **errore** to 0.9.0 (breaking: `_` → `Error` in matchError)

## 0.4.42

### Patch Changes

- fix **npx kimaki@latest** failing - update errore to 0.8.0 with fixed npm exports
- add **quick start mode** - skip OpenCode init when setup already done for faster bot startup
- refactor CLI into smaller helper functions for better maintainability

## 0.4.40

### Patch Changes

- add **/new-worktree** command to create git worktrees from Discord
- rename `/session` → **/new-session** for clarity
- fix **SSE deadlock** by increasing connection pool size
- fix **worktree thread creation** - check if worktree exists before creating thread
- fix **worktree message editing** - edit starter message when ready instead of sending new one
- send **multiple images in single message** for grid display
- migrate to **createTaggedError** factory for typed error handling
- update **errore** submodule to 0.7.1

## 0.4.39

### Patch Changes

- fix **0% token usage** race condition by fetching from API instead of relying on cached values
- display **subtask events** with indexed labels (explore-1, explore-2) for better tracking
- **filter hidden agents** from agent lists
- adopt **errore typed errors** across discord bot for better error handling

## 0.4.38

### Patch Changes

- fix **duplicate "kimaki"** in category names - now creates "Kimaki" instead of "Kimaki kimaki" when bot is named kimaki

## 0.4.37

### Patch Changes

- rename `start-session` → **`send`** command (alias kept for backwards compat)
- add **`--notify-only`** flag to create notification threads without starting AI session
- add **`app_id`** column to channel_directories for multi-bot support
- fix **JS number precision loss** for large Discord IDs in CLI arguments
- add **subfolder lookup** - walks up parent directories to find closest registered project
- fix **notification thread replies** to start new session with notification as context

## 0.4.36

### Patch Changes

- add **--project** option to `start-session` CLI command as alternative to `--channel`
- add **/remove-project** command to delete channels for a project from Discord
- add **agent** option to `/session` command for starting sessions with specific agent
- fix: use first option as **placeholder** in question tool dropdowns
- fix: limit Discord **command names to 32 characters**
- add **keep-running instructions** to CLI setup outro

## 0.4.35

### Patch Changes

- use **opencode from PATH** instead of hardcoded `~/.opencode/bin/opencode` path

## 0.4.34

### Patch Changes

- fix **numbered list code block unnesting** to avoid repeating numbers
- **send text parts immediately** when complete (time.end set)
- don't show typing indicator on question tool prompts
- instruct model to use **question tool on session end**
- fix(cli): **sanitize command names** by replacing colons with hyphens

## 0.4.33

### Patch Changes

- use **digit-with-period unicode** (⒈⒉⒊) for todo numbers instead of parenthesized digits
- add **heading depth limiter** for Discord markdown (converts h4+ to h3)

## 0.4.32

### Patch Changes

- feat: **flush pending text** before tool calls - ensures LLM text is shown before tools start
- feat: **show token usage** for large tool outputs (>3k tokens) with context percentage

## 0.4.31

### Patch Changes

- feat: **auto-create Kimaki role** on CLI startup for easier permission management
- feat: add **--install-url** CLI option to print bot invite URL without starting bot
- feat: **unnest code blocks from lists** for Discord compatibility
- perf: **parallelize CLI startup** operations for faster boot
- fix: **cancel pending question** when user sends new message
- fix: **flush pending text** before showing question dropdowns
- fix: **reply with helpful message** when user lacks Kimaki role
- fix: move **Kimaki role to bottom** position for easier assignment
- fix: prevent **infinite loop** in splitLongLine with small maxLength
- fix: context usage rendering with empty diamond symbol

## 0.4.30

### Patch Changes

- add **start-session** CLI command to programmatically create Discord threads and start sessions
- support **KIMAKI_BOT_TOKEN** env var for headless/CI usage
- add **ThreadCreate** handler to detect bot-initiated sessions with magic prefix
- add **channelId** to system prompt for session context
- add GitHub Actions example for automatic issue investigation
- docs: update README command table with /agent, /undo, /redo

## 0.4.29

### Patch Changes

- add **--data-dir** option for running multiple bot instances with separate databases
- **abbreviate paths** in project selection with `~` for home directory
- **filter out** `opencode-test-*` projects from channel creation lists
- docs: add multiple Discord servers section to README

## 0.4.28

### Patch Changes

- fix **Accept Always** not persisting - use v2 API (`permission.reply`) instead of deprecated v1 API

## 0.4.27

### Patch Changes

- replace `/accept`, `/accept-always`, `/reject` commands with **dropdown menu** for permission requests
- show Accept, Accept Always, and Deny options in a single dropdown

## 0.4.26

### Patch Changes

- add Discord dropdowns for AI question tool prompts
- add **/agent** command to set agent preference per channel or session
- add user-defined OpenCode slash command support
- add dev-mode file logging
- add abort-and-retry flow when switching models mid-session
- add graceful shutdown with SIGTERM before SIGKILL and **/stop** alias
- add image attachment downloads with prompt path inclusion
- add bot username to category names for multi-bot support
- fix OpenCode server startup reliability
- fix transcription errors sent to thread instead of channel
- fix long-line markdown splitting and inline markdown escaping
- fix `-cmd` command parsing
- chore: update **@opencode-ai/sdk** to 1.1.3 and gitignore tmp
- chore: simplify system prompt and silence noisy debug log
- refactor: update Discord message icons and formatting

## 0.4.25

### Patch Changes

- add **/queue** command to queue messages during active sessions
- add **/clear-queue** command to clear queued messages
- add **/undo** and **/redo** commands for session history navigation
- add **/fork** improvements - show last assistant message in selection
- feat: **auto-kill existing kimaki instance** instead of failing when another instance is running
- fix: **prevent killing own process** when checking for existing instance (use `-sTCP:LISTEN` flag)
- feat: **notification badge** on session completion message
- feat: **lowercase capitalization rules** in system prompt for Discord-style messaging
- refactor: extract commands into separate files with cleaner dispatcher

## 0.4.24

### Patch Changes

- add **test-model-id.ts** script for validating model ID format and provider.list API
- cleanup **pnpm-lock.yaml** - remove stale liveapi dependencies

## 0.4.23

### Patch Changes

- fix **command timeouts**: fixed issue where `/fork`, `/abort`, and `/share` commands would time out by deferring replies immediately
- fix **startup race condition**: fixed issue where interaction handlers were not registered if the client was already ready during startup
- add **/model command**: new command to set preferred model for a channel or session
- update **/model** to use dropdowns with models sorted by release date (newest first)
- improve **customId handling**: use hash keys for select menus to avoid Discord's 100-char limit on custom IDs

## 0.4.22

### Patch Changes

- add **table formatting** for Discord - markdown tables are converted to monospace code blocks for better readability
- add `formatMarkdownTables` utility and tests

## 0.4.21

### Patch Changes

- add **Manage Server** permission to allowed users (in addition to Owner/Admin)
- add **"Kimaki" role** support - users with a role named "Kimaki" (case-insensitive) can now interact with the bot
- add **model configuration** info to system prompt - explains how to change model via `opencode.json`
- update README with permissions and model configuration docs

## 0.4.20

### Patch Changes

- add **200ms debounce** after aborting interrupted sessions to prevent race conditions
- fix **race condition** where requests could hang if aborted between checks and async calls
- remove slow Discord API calls - use local SQLite for tracking sent parts instead of fetching messages
- move **⏳ reaction** to right before prompt (not on message arrival) so superseded requests don't leave orphaned reactions
- show **filename in italics** for edit/write tools: `◼︎ edit _file.ts_ (+5-3)`
- use **italics** for bash commands and tool titles instead of backticks

## 0.4.19

### Patch Changes

- add **single instance lock** to prevent running multiple kimaki bots
- add `/add-new-project` command to create project folder, init git, and start session
- add `/share` command to share current session as public URL
- show **tool running status** immediately instead of waiting for completion
- inform user that **bash outputs are not visible** in system prompt
- add README best practices for notifications, long messages, permissions

## 0.4.18

### Patch Changes

- mention long files as uploadable in system prompt

## 0.4.17

### Patch Changes

- remove misleading error message in upload-to-discord

## 0.4.16

### Patch Changes

- move upload-to-discord instructions to system prompt instead of separate command

## 0.4.15

### Patch Changes

- re-publish with CLI command fixes

## 0.4.14

### Patch Changes

- add `upload-to-discord` CLI command to upload files to Discord thread
- add `/upload-to-discord` OpenCode command for LLM-driven file uploads
- refactor system prompt to include session ID for LLM access
- remove plugin dependency - commands now instruct LLM to run CLI directly
- rename command files to support multiple commands

## 0.4.13

### Patch Changes

- bash tool displays actual command in inline code (`` `command` ``) instead of description when short (≤120 chars, single line)

## 0.4.12

### Patch Changes

- system prompt instruction for 85 char max code block width to prevent Discord wrapping

## 0.4.11

### Patch Changes

- preserve code block formatting when splitting long Discord messages
- add closing/opening fences when code blocks span multiple messages
- use marked Lexer for robust markdown parsing instead of regex

## 0.4.10

### Patch Changes

- show "Creating Discord thread..." toast at start of command
- update command description to clarify it creates a Discord thread

## 0.4.9

### Patch Changes

- improve error handling in OpenCode plugin, check stderr and stdout for error messages

## 0.4.8

### Patch Changes

- add `send-to-discord` CLI command to send an OpenCode session to Discord
- add OpenCode plugin for `/send-to-kimaki-discord` command integration

## 0.4.7

### Patch Changes

- add `/accept`, `/accept-always`, `/reject` commands for handling OpenCode permission requests
- show permission requests in Discord thread with type, action, and pattern info
- `/accept-always` auto-approves future requests matching the same pattern

## 0.4.6

### Patch Changes

- add support for images
- update discord sdk

## 0.4.5

### Patch Changes

- Batch assistant messages in resume command to avoid spamming Discord with multiple messages for single response
- Add SIGUSR2 signal handler to restart the process

## 0.4.4

### Patch Changes

- add used model info

## 0.4.3

### Patch Changes

- fix: truncate autocomplete choices to 100 chars in resume and add-project commands to avoid DiscordAPIError[50035]
- fix: filter out autocomplete choices in session command that exceed Discord's 100 char value limit

## 0.4.2

### Patch Changes

- Revert 0.4.1 changes that caused multiple event listeners to accumulate

## 0.4.1

### Patch Changes

- Separate abort controllers for event subscription and prompt requests (reverted in 0.4.2)

## 0.4.0

### Minor Changes

- hide the too many params in discord

## 0.3.2

### Patch Changes

- support DOMException from undici in isAbortError

## 0.3.1

### Patch Changes

- display custom tool calls in Discord with tool name and colon-delimited key-value fields
- add special handling for webfetch tool to display URL without protocol
- truncate field values at 100 chars with unicode ellipsis

## 0.3.0

### Minor Changes

- Fix abort errors after 5 mins. DIsable permissions.

## 0.2.1

### Patch Changes

- fix fetch timeout. restore voice channels

## 0.2.0

### Minor Changes

- simpler onboarding. do not ask for server id

## 0.1.6

### Patch Changes

- Check for OpenCode CLI availability at startup and offer to install it if missing
- Automatically install OpenCode using the official install script when user confirms
- Set OPENCODE_PATH environment variable for the current session after installation
- Use the discovered OpenCode path for all subsequent spawn commands

## 0.1.5

### Patch Changes

- Store database in homedir

## 0.1.5

### Patch Changes

- Move database file to ~/.kimaki/ directory for better organization
- Database is now stored as ~/.kimaki/discord-sessions.db

## 0.1.4

### Patch Changes

- Store gemini api key in database

## 2025-09-25

- Switch audio transcription from OpenAI to Gemini for unified API usage
- Store Gemini API key in database for both voice channels and audio transcription
- Remove OpenAI API key requirement and dependency
- Update CLI to only prompt for Gemini API key with clearer messaging

## 0.1.3

### Patch Changes

- Nicer onboarding

## 0.1.2

### Patch Changes

- fix entrypoint bin.sh

## 0.1.1

### Patch Changes

- fix woring getClient call

## 0.1.0

### Minor Changes

- init

## 2025-09-24 09:20

- Add comprehensive error handling to prevent process crashes from corrupted audio data
- Add error handlers to prism-media opus decoder to catch "The compressed data passed is corrupted" errors
- Add error handlers to all stream components in voice pipeline (audioStream, downsampleTransform, framer)
- Add error handling in genai-worker for resampler, opus encoder, and audio log streams
- Add write callbacks with error handling for stream writes
- Add global uncaughtException and unhandledRejection handlers in worker thread
- Prevent Discord browser clients' corrupted opus packets from crashing the bot

## 2025-09-23 14:15

- Update PCM audio logging to only activate when DEBUG environment variable is set
- Extract audio stream creation into `createAudioLogStreams` helper function
- Use optional chaining for stream writes to handle missing streams gracefully
- Simplify cleanup logic with optional chaining

## 2025-09-23 14:00

- Add PCM audio logging for Discord voice chats
- Audio streams for both user input and assistant output saved to files
- Files saved in `discord-audio-logs/<guild_id>/<channel_id>/` directory structure
- Format: 16kHz mono s16le PCM with FFmpeg-compatible naming convention
- Automatic cleanup when voice sessions end
- Add documentation for audio file playback and conversion

## 2025-09-22 12:05

- Fix event listener leak warning by removing existing 'start' listeners on receiver.speaking before adding new ones
- Add { once: true } option to abort signal event listener to prevent accumulation
- Stop existing voice streamer and GenAI session before creating new ones in setupVoiceHandling
- Prevent max event listeners warning when voice connections are re-established

## 2025-09-22 11:45

- Replace AudioPlayer/AudioResource with direct voice streaming implementation
- Create `directVoiceStreaming.ts` module that uses VoiceConnection's low-level APIs
- Implement custom 20ms timer cycle for Opus packet scheduling
- Handle packet queueing, silence frames, and speaking state directly
- Remove dependency on discord.js audio player abstraction for continuous streaming

## 2025-09-22 10:15

- Add tool support to `startGenAiSession` function
- Import `aiToolToCallableTool` from liveapi package
- Convert AI SDK tools to GenAI CallableTools format
- Handle tool calls and send tool responses back to session

## 2025-09-21

- Add `/resume` slash command for resuming existing OpenCode sessions
- Implement autocomplete for session selection showing title and last updated time
- Create new Discord thread when resuming a session
- Fetch and render all previous messages from the resumed session
- Store thread-session associations in SQLite database
- Reuse existing part-message mapping logic for resumed sessions
- Add session-utils module with tests for fetching and processing session messages
- Add `register-commands` script for standalone command registration

## 2025-01-25 01:30

- Add prompt when existing channels are connected to ask if user wants to add new channels or start server immediately
- Skip project selection flow when user chooses to start with existing channels only
- Improve user experience by not forcing channel creation when channels already exist

## 2025-01-25 01:15

- Convert `processVoiceAttachment` to use object arguments for better API design
- Add project file tree context to voice transcription prompts using `git ls-files | tree --fromfile`
- Include file structure in transcription prompt to improve accuracy for file name references
- Add 2-second timeout for thread name updates to handle rate limiting gracefully

## 2025-01-25 01:00

- Refactor message handling to eliminate duplicate code between threads and channels
- Extract voice transcription logic into `processVoiceAttachment` helper function
- Simplify project directory extraction and validation
- Remove unnecessary conditional branches and streamline control flow
- Update thread name with transcribed content after voice message transcription completes

## 2025-01-25 00:30

- Add voice message handling to Discord bot
- Transcribe audio attachments using OpenAI Whisper before processing
- Transform voice messages to text and reuse existing text message handler
- Support all audio/\* content types from Discord attachments

## 2025-01-25 00:15

- Update todowrite rendering to use unicode characters (□ ◈ ☑ ☒) instead of text symbols
- Remove code block wrapping for todowrite output for cleaner display

## 2025-01-24 23:30

- Add voice transcription functionality with OpenAI Whisper
- Export `transcribeAudio` and `transcribeAudioWithOptions` functions from new voice.ts module
- Support multiple audio input formats: Buffer, Uint8Array, ArrayBuffer, and base64 string

## 2025-01-24 21:10

- Refactor typing to be local to each session (not global)
- Define typing function inside event handler as a simple local function
- Start typing on step-start events
- Continue typing between parts and steps as needed
- Stop typing when session ends via cleanup
- Remove all thinking message code

## 2025-01-24 19:50

- Changed abort controller mapping from directory-based to session-based to properly handle multiple concurrent sessions per directory
