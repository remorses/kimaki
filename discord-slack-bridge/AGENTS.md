<!-- Purpose: Immutable bridge-specific engineering rules for discord-slack-bridge. -->

# discord-slack-bridge

## Package purpose

This package exists to let Kimaki (from the `cli` package) run on Slack in
the future with minimal behavior differences. The adapter translates Discord
Gateway and REST semantics to Slack APIs so Kimaki can keep the same runtime
model:

- Discord `guild` maps to Slack `team` (workspace).
- Discord channels map to Slack channels.
- Discord threads map to Slack threads (similar reply-thread model).

The goal is feature parity where Kimaki behaves in Slack as close as possible
to how it behaves in Discord, with this bridge handling protocol translation.

## Canonical references

- Bridge behavior spec: `slop/discord-slack-bridge-spec.md`
- Bridge implementation:
  - `discord-slack-bridge/src/server.ts`
  - `discord-slack-bridge/src/event-translator.ts`
  - `discord-slack-bridge/src/rest-translator.ts`
  - `discord-slack-bridge/src/file-upload.ts`
  - `discord-slack-bridge/src/component-converter.ts`
  - `discord-slack-bridge/src/gateway.ts`
  - `discord-slack-bridge/src/types.ts`
- Slack SDK request type references:
  - `opensrc/repos/github.com/slackapi/node-slack-sdk/packages/web-api/src/types/request/chat.ts`
  - `opensrc/repos/github.com/slackapi/node-slack-sdk/packages/web-api/src/types/request/conversations.ts`
  - `opensrc/repos/github.com/slackapi/node-slack-sdk/packages/web-api/src/types/request/reactions.ts`
  - `opensrc/repos/github.com/slackapi/node-slack-sdk/packages/web-api/src/types/request/files.ts`
  - `opensrc/repos/github.com/slackapi/node-slack-sdk/packages/web-api/src/types/request/views.ts`

## Echo bot integration smoke checks

- Use `discord-slack-bridge/scripts/echo-bot.ts` to verify end-to-end Slack + gateway behavior.
- For deployed gateway testing, run `pnpm echo-bot --gateway` from `discord-slack-bridge/`.
- This validates Discord REST + Gateway routing through `slack-gateway.kimaki.dev` and Slack webhook/interactivity handling at `/slack/events`.
- Important: this requires real user interaction in Slack. The script only starts the bridge client and registers commands; someone must send messages, run slash commands, and click interactive components in Slack to exercise Events + Interactivity webhooks end-to-end.

## Non-negotiable typing rules

- Do not use `as` assertions/casts in bridge source code.
- Do not duplicate Slack payload types when official SDK/types are available.
- Prefer `@slack/web-api` concrete request argument types for API calls
  (e.g. `satisfies ChatPostMessageArguments`).
- **Slack API response types**: use the SDK response types for all Slack API
  call results. The WebClient methods return typed responses
  (`ChatPostMessageResponse`, `ConversationsInfoResponse`, etc.) — access
  fields directly on the result (e.g. `result.ts`, `result.channel?.name`)
  instead of passing them through `Record<string, unknown>` + `readString`
  helpers. This ensures misspelled field names are caught at compile time.
- **Extracting nested Slack types**: the SDK does not re-export nested types
  like `Channel`, `User`, `MessageElement` from the main entry because they
  collide across response modules. Use indexed access on the response type:
  ```ts
  import type { ConversationsInfoResponse } from '@slack/web-api'
  type SlackChannel = NonNullable<ConversationsInfoResponse['channel']>
  ```
  See `rest-translator.ts` imports for the full set of extracted types.
- Prefer importing Slack types from the official Slack SDK instead of defining
  bridge-local copies. This keeps bridge code aligned with Slack's source of
  truth and automatically in sync when Slack updates type definitions.
- Keep inbound payload boundary normalization in `server.ts`:
  - parse as `unknown`
  - validate/narrow at runtime
  - pass normalized typed objects downstream
- The `Record<string, unknown>` + `readString`/`readRecord` pattern is ONLY
  acceptable for inbound webhook payloads from Slack Events API (raw JSON that
  needs runtime validation). Never use it for Slack SDK WebClient responses.

## Protocol/constants rules

- Avoid magic numbers and string literals for Discord protocol values.
- Prefer enums and protocol types from `discord-api-types/v10`.
- Follow payload-shaping patterns used by `discord-digital-twin`.

## ID mapping between Discord and Slack

discord.js parses certain IDs as BigInt snowflakes internally (for
`createdTimestamp`, sorting, caching). Any ID that discord.js treats as a
snowflake **must** be a valid BigInt string — non-numeric IDs like
`MSG_C04_17000...` cause `Cannot convert to BigInt` crashes at runtime.

### Which IDs must be snowflake-compatible

**Message IDs** — always parsed as BigInt by discord.js (`Snowflake.timestampFrom`
in `Message._patch`). Must be pure numeric.

**Thread channel IDs** — also parsed as snowflakes because discord.js treats
threads as channels and accesses `createdTimestamp` on them. Must be pure
numeric.

**Guild/channel/user IDs** — discord.js does NOT parse these as snowflakes in
tested code paths (only `createdTimestamp` getter would break, which typical
bot code doesn't call). These keep their Slack format as-is (`T04ABC123`,
`C04ABC123`, `U04ABC123`).

### Encoding scheme

```
Guild ID    →  Slack workspace ID as-is    (T04ABC123)
Channel ID  →  Slack channel ID as-is      (C04ABC123)
User ID     →  Slack user ID as-is         (U04ABC123)
Message ID  →  Slack ts with dot stripped   (1700000000000001)  [16 digits]
Thread ID   →  {ts_16}{channelLen_2}{channelBase36Pairs}       [20+ digits]
```

Slack timestamps have format `"1700000000.000001"` (integer seconds + 6-digit
microsecond suffix). Stripping the dot produces a 16-digit numeric string.

### Thread ID format

Thread IDs are **reversible** — they encode both the Slack channel and
thread_ts so `decodeThreadId` can recover the original values without any
runtime state:

```
{ts_no_dot_16}{channel_char_count_2}{channel_base36_pairs}

Example: channel "C04ABC123" (9 chars) + ts "1700000000.000001"
→ "1700000000000001" + "09" + "120004101112010203"
→ "170000000000000109120004101112010203"  (36 digits)
```

Each character of the Slack channel ID is encoded as a 2-digit base-36
value (0-9 → 00-09, A-Z → 10-35). The encoding is fully reversible via
`channelToNumeric`/`numericToChannel` in `id-converter.ts`.

This design guarantees **no cross-channel thread ID collisions** — same
`thread_ts` in different channels always produces different Discord IDs.

With reversible encoding, `resolveSlackTarget` decodes the channel directly
from the thread ID. No runtime map is needed for ID resolution.

`knownThreads` in `server.ts` is now a bounded `Set<string>` used only for
THREAD_CREATE event dedup (don't announce the same thread twice). Entries are
keyed by encoded thread ID (`encodeThreadId(channel, threadTs)`) so same
`thread_ts` values in different channels do not collide.

### Distinguishing threads from channels

Thread IDs are 20+ digits (16 ts + 2 len + 2+ channel encoding).
Message IDs are exactly 16 digits. Slack channel IDs start with a letter.
`isThreadChannelId(id)` checks `^\d{20,}$` — unambiguous discrimination.

### Legacy format support

The decoders (`decodeMessageId`, `decodeThreadId`) still accept the old
`MSG_channel_ts` and `THR_channel_ts` prefixed formats for backward
compatibility. `resolveSlackTarget` also handles legacy `THR_` IDs.

### Implementation files

- `id-converter.ts` — all encode/decode/resolve functions, base36 helpers
- `server.ts` — `knownThreads` Set (event dedup only), bounded with eviction,
  channel-scoped keys
- `event-translator.ts` — uses `encodeThreadId`/`encodeMessageId` for
  gateway events
- `rest-translator.ts` — uses `resolveSlackTarget` (no map param needed)

## Validation rules

- After bridge changes, always run:
  - `cd discord-slack-bridge && pnpm typecheck && pnpm test --run`
  - `cd cli && pnpm tsc`

## Website KV auth cache architecture (Slack gateway)

The website worker now does auth/routing cache in Cloudflare KV instead of
isolate memory or Worker Cache API for Slack gateway traffic.

- KV key `gateway-client:v1:<clientId>` stores one gateway client auth record
  (same fields as `gateway_clients` row shape used by runtime auth checks).
- KV key `team-client-ids:v1:<teamId>` stores `{ clientIds: string[] }` used by
  Slack webhook fanout routing.
- OAuth callback write-through updates both DB and KV so a new install is
  immediately routable/authenticated without waiting for a miss.
- On KV miss, worker reads DB and repopulates KV (read-through behavior).

### KV + database interaction contract

- `gateway_clients` in Postgres is the source of truth.
- KV is a short-lived acceleration layer only; never rely on KV alone for
  correctness.
- OAuth callback and any future mapping writers should use the shared
  `upsertGatewayClientAndRefreshKv(...)` helper in
  `website/src/gateway-client-kv.ts` so write behavior stays consistent.
- That helper writes the client row cache key and invalidates the team fanout
  list key. Team fanout list is rebuilt lazily from DB on next miss.
- For auth checks, the DO/runtime should resolve client data via KV first, then
  DB fallback (`resolveGatewayClientFromCacheOrDb(...)`) and repopulate KV.
- If DB and KV disagree, DB wins and KV should be overwritten by the latest DB
  row.

Revalidation and revocation behavior:

- KV entries use short TTLs and expire automatically.
- Expired/missing entries force DB revalidation on next request.
- This is intentional so revoking a client secret, banning a user, or removing
  team access in DB propagates after TTL without requiring explicit cache purge.
- Do not increase TTLs aggressively; short TTL is part of the security model.
