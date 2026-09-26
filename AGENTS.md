# Kimaki agent instructions

Kimaki's main package is `cli/`, the Discord bot and CLI. Read the relevant section of [docs/agent-reference.md](docs/agent-reference.md) before work on gateway onboarding, SQLite/Prisma, Discord interactions, session events, tests, plugins, releases, or the Slack bridge. For session-state tests, also read [docs/e2e-testing-learnings.md](docs/e2e-testing-learnings.md). Do not load the full reference for unrelated work.

## Before editing

- Load the `changesets` skill for fixes or features. Add or update a pending changeset for user-facing behavior.
- This repo uses errore conventions. Read the `errore` skill before code changes.
- Check `git status -s -u` and `git diff` first. Do not overwrite unrelated work.
- Use `@opencode-ai/sdk/v2`, not the v1 SDK. It takes flat parameters: `session.get({ sessionID })`.
- Do not use `spawnSync`; use `execAsync`. Avoid `as any`.
- Only restart the Discord bot when the user explicitly asks.

## Checks

- After every change, run `pnpm tsc` inside `cli/`.
- After important queue or message-handling changes, run `pnpm run test --run -u` inside `cli/` and inspect snapshot diffs. For one test file, use `pnpm run test --run src/example.test.ts`.
- Run `lintcn lint` in the edited package at the end.

## Session and Discord invariants

- Use the OpenCode event stream as the source of truth for session state. Before changing `cli/src/session-handler/thread-session-runtime.ts`, load `event-sourcing-state`. Prefer pure derivation in `event-stream-state.ts` to mirrored flags. For a reported session bug, export its event JSONL first.
- Use `resolveWorkingDirectory({ channel })` for command paths. Use `projectDirectory` for the server and `workingDirectory` for shell and SDK calls.
- Discord interactions can have cached or raw member shapes. Narrow at runtime; fail closed on missing permission context.
- Component `custom_id` is at most 100 characters; message `nonce` is at most 25. Never embed paths or UUIDs directly.
- Keep multi-tenant gateway REST access guild-scoped or explicitly token-scoped. Never forward client-authenticated unscoped bot-token requests.
- Do not edit generated `cli/src/schema.sql`. Change `cli/schema.prisma`, run `pnpm generate`, and migrate existing SQLite databases in `db.ts` when the schema requires it.
- OpenCode plugin entry modules must export only plugin initializers. Never log to stdout or import the CLI logger from a plugin.

## Repository layout

- `cli/`: bot, CLI, local SQLite, OpenCode integration.
- `gateway-proxy/`: multi-tenant Discord REST and Gateway proxy.
- `website/`: onboarding and docs. `db/`: shared Postgres schema.
- `docs/agent-reference.md`: detailed procedures and implementation gotchas. Read its specific section when needed.
