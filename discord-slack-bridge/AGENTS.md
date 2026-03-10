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

## Validation rules

- After bridge changes, always run:
  - `cd discord-slack-bridge && pnpm typecheck && pnpm test --run`
  - `cd discord && pnpm tsc`
