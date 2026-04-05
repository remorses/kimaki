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

## undici is a devDependency but easy to miss-install

`discord/package.json` lists `undici: ^8.0.2` as a devDependency (used by
`gateway-proxy-reconnect.e2e.test.ts` for `setGlobalDispatcher`). If you
see `Cannot find package 'undici'` from that test, just run `pnpm install`
inside `discord/`. Do NOT assume it's a transitive dep — the comment in
`discord-bot.ts:125` saying "undici is a transitive dep from discord.js"
is misleading for the test file which needs the explicit dependency.
