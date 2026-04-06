# Session learnings

## Prompt ingress architecture

All user prompts funnel through `ThreadSessionRuntime.enqueueIncoming` in
`discord/src/session-handler/thread-session-runtime.ts`. This is the single
centralized injection point for any cross-cutting prompt transformation
(command detection, prefix stripping, etc). The 6 sources that funnel here:

1. Discord chat messages → `discord-bot.ts` MessageCreate → `preprocess*Message` → `enqueueWithPreprocess`
2. `/new-session` slash → `commands/session.ts` → `enqueueIncoming` directly
3. `/queue` slash → posts Discord message with `» **user:** ...` prefix → path #1
4. `kimaki send --thread` (existing thread) → posts `» **kimaki-cli:** <prompt>` → path #1
5. `kimaki send --channel` (new thread) → raw starter message → bot `ThreadCreate` handler → `enqueueIncoming` with preprocess callback
6. Scheduled tasks (`task-runner.ts`) → posts Discord messages like #4/#5

Prefix conventions: `» **<username>:** ` is used for queued reposts and
CLI-injected messages in existing threads. New-thread flows (channel-level
`kimaki send` and channel scheduled tasks) post the raw prompt without
prefix and rely on an embed marker (`ThreadStartMarker` YAML) for metadata.

## Cross-cutting transformations — do them in two places

When adding a prompt-level transformation (like leading `/command` detection):
- Call the transformer inside `enqueueIncoming()` for sources that provide
  a ready `prompt`.
- ALSO call it inside `enqueueWithPreprocess()` after the preprocess callback
  resolves — otherwise preprocess-based inputs (including `ThreadCreate` flow
  and Discord chat messages) skip the transformation.
- No double-conversion risk: `enqueueIncoming` returns early to
  `enqueueWithPreprocess` when `input.preprocess` is set.

## preprocessNewSessionMessage wraps prompts

`preprocessNewSessionMessage()` wraps the user prompt with
`Context from thread:\n${starterText}\n\nUser request:\n${prompt}` when the
starter message differs from the current message. This breaks any
prefix-based detection (leading `/command`, etc) because the command is no
longer at the start of the prompt.

**Fix pattern**: run the detector on the raw prompt BEFORE wrapping and
skip the wrapping when detection succeeds.

## Prefer line-based detection over prefix stripping

When adding a transformation that needs to match a user-intent pattern in
prompts that sometimes carry programmatic prefixes (`» **kimaki-cli:** ...`,
`» **user:** ...`, `Context from thread: ...`), do NOT try to regex-strip
every possible prefix before matching. That creates maintenance burden
(new prefix formats silently break detection) and gets the semantics
wrong when usernames contain regex metacharacters.

Instead:
1. Split the prompt by `\n` and check each line
2. Always put programmatic prefixes on their OWN line (separated by `\n`
   from the user's content), so the user's text starts at a fresh line
3. Detection only scans each line's first non-whitespace token

This makes detection oblivious to prefix format — it Just Works for any
current or future prefix line.

## Discord display names can contain `*`

When writing regexes to match markdown-formatted names like `**<name>:**`,
use non-greedy `[\s\S]+?` instead of `[^*]+`. Discord display names can
(rarely) contain `*`. Better long-term fix: escape usernames at render
time or pass structured metadata instead of parsing markdown.

## Commit only your own files when other agents are editing concurrently

`git status` frequently shows modifications from other agents running in
parallel on the same repo. Never `git add -A` or `git add .`. Always
enumerate your files explicitly:

```bash
git commit path/to/file1 path/to/file2 -m "message"
```

Before committing, run `git status -s` and `git diff <file>` on any file
you don't remember touching. If it's unrelated to your task, leave it out
of the commit.

## Discord thread rename is heavily rate-limited

Discord rate-limits channel/thread renames to ~2 per 10 minutes per thread,
and the limit is **undocumented** in headers — `setName()` will silently
block on the 3rd attempt rather than returning 429. See
discord/discord-api-docs#1900 and discordjs/discord.js#6651.

Design rules for any code that calls `thread.setName()`:

- Rename at most once per distinct new value (dedup via a runtime-local field).
- Race `setName()` against `AbortSignal.timeout(...)` (discord.js doesn't
  take a signal directly, so wrap in `Promise.race`).
- Fail soft on timeout/429/error — log and continue, never retry.
- Don't let a blocked rename block queue draining, typing, or event handling.

Reference implementation: `handleSessionUpdated` in
`discord/src/session-handler/thread-session-runtime.ts`.

## OpenCode session.updated event carries the generated title

When an OpenCode session is created without a title, OpenCode generates a
summary title from the first turn and emits a `session.updated` event with
the full `Session` object (including `info.title`). See
`@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` types `EventSessionUpdated`
and `Session`. The title starts as a placeholder matching
`/^new session\s*-/i` — skip renames until a real title arrives (matches
the filter in `external-opencode-sync.ts`).

## OpenCode permission.reply cannot widen/change scope — patterns are fixed by permission.asked

`client.permission.reply({ requestID, directory, workspace, reply, message })`
is the only SDK method to answer a `permission.asked` event. The body only
accepts `reply: "once" | "always" | "reject"` plus an optional `message`.
There is **no** field to override the directory/path/patterns of the
permission. The `directory` and `workspace` query params are just routing
hints to identify which OpenCode server context the reply belongs to —
they do NOT change what the "always" rule covers.

The scope of "always" is determined entirely by `PermissionRequest.patterns`
set by OpenCode when it emitted `permission.asked`. If you want a broader
rule (e.g. grant permission for a parent directory instead of a single
file), the user must configure permission rules in OpenCode config / via
per-session `permissions` option (see `parsePermissionRules` and the
`--permission "tool:pattern:action"` CLI flag in
`discord/src/session-handler/thread-session-runtime.ts`), not via
`permission.reply`.

There is also a legacy `PermissionRespond` endpoint
(`POST /session/{sessionID}/permissions/{permissionID}`) with the same
body shape — no scope override there either.

## undici is a devDependency but easy to miss-install

`discord/package.json` lists `undici: ^8.0.2` as a devDependency (used by
`gateway-proxy-reconnect.e2e.test.ts` for `setGlobalDispatcher`). If you
see `Cannot find package 'undici'` from that test, just run `pnpm install`
inside `discord/`. Do NOT assume it's a transitive dep — the comment in
`discord-bot.ts:125` saying "undici is a transitive dep from discord.js"
is misleading for the test file which needs the explicit dependency.
