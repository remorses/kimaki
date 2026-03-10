<!-- Purpose: Immutable bridge-specific engineering rules for discord-slack-bridge. -->

# discord-slack-bridge

## Package purpose

This package exists to let Kimaki (from the `discord` package) run on Slack in
the future with minimal behavior differences. The adapter translates Discord
Gateway and REST semantics to Slack APIs so Kimaki can keep the same runtime
model:

- Discord `guild` maps to Slack `team` (workspace).
- Discord channels map to Slack channels.
- Discord threads map to Slack threads (similar reply-thread model).

The goal is feature parity where Kimaki behaves in Slack as close as possible
to how it behaves in Discord, with this bridge handling protocol translation.

## Canonical references

- Bridge behavior spec: `docs/discord-slack-bridge-spec.md`
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
Message ID  →  Slack ts with dot stripped   (1700000000000001)
Thread ID   →  Slack ts with dot stripped   (1700000000000001)
```

Slack timestamps have format `"1700000000.000001"` (integer seconds + 6-digit
microsecond suffix). Stripping the dot produces a numeric string parseable as
BigInt.

### Thread ID = parent message ID

In Slack, a thread IS its parent message — identified by `thread_ts` which
equals the parent message's `ts`. So the thread channel ID and the parent
message ID are the same numeric value. This is natural and avoids inventing
synthetic IDs.

### Thread → parent channel resolution

The numeric thread ID only encodes the `thread_ts`, not which Slack channel
the thread lives in. To send messages to a thread, we need the parent Slack
channel ID. This is maintained at runtime in `knownThreads: Map<string, string>`
(threadTs → parentChannelId) in `server.ts`. It gets populated when:

1. **Webhook event** arrives with `thread_ts` (Slack → Discord direction)
2. **REST create-thread** request from discord.js (Discord → Slack direction)

All functions that need to resolve a Discord channel ID to a Slack target
(`resolveSlackTarget`) accept a `threadMap` parameter for this lookup.

### Distinguishing threads from channels

`isThreadChannelId(id)` checks if an ID is pure numeric with 7+ digits.
Slack channel IDs always start with a letter (`C`, `G`, `D`), so there's
no ambiguity.

### Legacy format support

The decoders (`decodeMessageId`, `decodeThreadId`) still accept the old
`MSG_channel_ts` and `THR_channel_ts` prefixed formats for backward
compatibility. New code always produces numeric-only IDs.

### Implementation files

- `id-converter.ts` — all encode/decode/resolve functions
- `server.ts` — `knownThreads` map, thread registration on create/discover
- `event-translator.ts` — uses `encodeThreadId`/`encodeMessageId` for
  gateway events
- `rest-translator.ts` — uses `resolveSlackTarget` with `threadMap` for
  all REST operations

## Validation rules

- After bridge changes, always run:
  - `cd discord-slack-bridge && pnpm typecheck && pnpm test --run`
  - `cd discord && pnpm tsc`
