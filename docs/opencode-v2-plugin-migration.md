---
title: OpenCode 2.0.2 Kimaki plugin integration
description: >
  How the built Kimaki plugin extends the stable OpenCode 2.0.2 server used by
  the existing CLI and Discord runtime.
---

# OpenCode 2.0.2 Kimaki plugin integration

Kimaki uses a built OpenCode plugin **inside the existing `cli/` package**. The plugin extends one shared OpenCode server; it does not replace the Discord bot, create a second CLI package, or define a future cutover.

The stable dependency set is `@opencode/client@2.0.2`, `@opencode/plugin@2.0.2`, and `@opencode/cli@2.0.2`. The installed CLI maps its `opencode` and `opencode2` aliases to the same native **`bin/opencode.exe`** file.

## Runtime shape

```text
Kimaki Discord process
      │
      ├─ @opencode/client ──► one OpenCode server, many locations
      │                              │
      │                              ├─ native inbox and execution
      │                              ├─ native forms and instructions
      │                              └─ global SSE event stream
      │
      └─ generated server config
             ├─ dist/kimaki-opencode-plugin
             └─ @subrouter/opencode provider
```

`cli/src/opencode.ts` writes the generated config, checks that the built plugin entry exists, and starts the native server with Basic authentication. The config points at the plugin directory, not a TypeScript source file.

The Discord runtime calls native session APIs directly. It uses inbox delivery for steering and queueing, execution terminal events for completion, forms for questions, and instruction entries for the durable Kimaki system prompt.

## Built plugin

The source entry is `cli/src/kimaki-opencode-plugin/index.ts`. TypeScript emits it with its sibling runtime modules under `cli/dist/`; OpenCode loads `cli/dist/kimaki-opencode-plugin` as a directory.

The default export is one `Plugin.define({ id: "kimaki", setup })` plugin. No helper is exported from the plugin entry because OpenCode treats exported functions as plugin initializers.

The plugin provides these implemented features:

| Area | Implementation |
|---|---|
| Subrouter | Adds session and agent route-affinity headers, reveals the selected routed model, and clears live routes on terminal execution events |
| Injection guard | Selectively scans tool output and replaces output that crosses the configured confidence threshold |
| File-edit tracking | Runs file-edit hooks after `edit`, `write`, and `apply_patch`, then appends durable JSONL records |
| Context | Adds branch, detached-head, working-directory, onboarding, and condensed memory instructions through the native context hook |
| Tool schema | Adds Discord rendering metadata to the shell tool input |
| Discord tools | Registers file upload, action buttons, and durable sleep tools |

The plugin uses the native `model.request`, `context`, and tool transformation hooks. It subscribes to execution and session lifecycle events for route cleanup.

## Process and location rules

One OpenCode server serves all project directories. Plugin `setup()` can run for each location, while module code and `globalThis` remain process-wide.

The implementation follows these rules:

- Process-wide initialization uses symbols on `globalThis`.
- Session context is keyed by `sessionID`.
- Location-specific configuration comes from `ctx.location.directory`.
- Event subscribers do not assume that the process bus contains only one location.
- Cleanup aborts the plugin's event subscription without stopping the Discord bot.

These rules prevent duplicate resources and cross-project state leaks when the same plugin directory is active for several project locations.

## Native runtime ownership

The plugin does not own the Discord session state machine. `cli/src/session-handler/thread-session-runtime.ts` owns Discord rendering and interaction flow using native OpenCode facts.

Current ownership is:

| Concern | Owner |
|---|---|
| Prompt admission and queue delivery | Native session inbox APIs and `session.inbox.*` events |
| Run start, success, failure, interruption | `session.execution.*` events |
| Text, reasoning, and tool rendering | Discord runtime folds native stream facts |
| Questions | Native forms plus Discord controls |
| Permissions | Native permission requests and replies |
| Durable Kimaki system prompt | `session.instructions.entry.put` |
| Provider routing | Subrouter provider plus plugin request hook |
| File edit history | Plugin tool transform plus `file-edit-events.jsonl` |

This split keeps OpenCode as the source of truth for session execution while the Discord process remains responsible for Discord API behavior and durable thread mappings.

## Event folding

Live text and reasoning events are deltas. Kimaki appends them by assistant message and ordinal, then replaces the buffer with the complete value from the matching ended event. Tool events are keyed by assistant message and tool ID.

The Discord footer comes only from `session.execution.succeeded`. Interrupted and failed executions settle state without a success footer. Typing follows native busy and execution events, not the arrival of a Discord user message.

The global SSE listener maintains one connection for all thread runtimes. If it reconnects, each active runtime replays durable session logs for the main session and its subagents, then reloads pending forms through `@opencode/client`. Missed deltas are not replayable, but durable completed output and execution state are restored.

## Native input paths

Normal Discord messages use:

```ts
await client.session.prompt({
  sessionID,
  text,
  files,
  delivery: 'steer',
})
```

Queued messages use `delivery: "queue"`. Context that must not create an assistant response uses `session.synthetic` with `resume: false`. Interruptions use `session.interrupt`; there is no abort, timer, and prompt replay path.

Before prompt admission, Kimaki stores its durable system instructions:

```ts
await client.session.instructions.entry.put({
  sessionID,
  key: 'kimaki',
  value: systemInstructions,
})
```

The context hook adds request-specific material after this entry. It does not replace instruction epochs with a one-off prompt string.

## Verification

The implementation is covered at several levels:

- Server tests start the native OpenCode 2.0.2 executable and verify authenticated session APIs.
- Plugin loading tests build and load the plugin directory.
- Inbox tests cover steer, queue, cancellation, delivery, and interruption.
- Deterministic provider tests verify native text, tool, and execution events.
- Event-stream tests verify pure derivation for completion, forms, permissions, usage, and subagents.
- Discord end-to-end tests verify the user-visible thread output.

## Current limitations

- SSE is volatile. Reconciliation restores durable content and pending forms, not missed token animation.
- The plugin host activates per location, so new process-wide resources still need explicit singleton ownership.
- Some HTTP capabilities are not present on the plugin `SessionDomain`; the Discord runtime uses `@opencode/client` for those operations.
- File-edit tracking records recognized OpenCode edit tools. Shell commands that modify files are outside that tool-level record.

The plugin rewrite, single-server cutover, native inbox, forms, instructions, Subrouter, injection guard, file-edit tracking, and SSE reconciliation are complete. They are current architecture, not migration phases.
