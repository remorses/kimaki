---
'kimaki': patch
---

Fix interrupting a busy session not actually working. Sending a new message while the bot was mid-run (for example during a long-running tool) often failed to abort and replay the queued message, so the interrupt was silently dropped and the new message only ran after the slow turn finished.

Two root causes are fixed:

**1. The plugin's `ctx.client` did not make REST calls reliably.** The OpenCode interrupt/resume plugin runs inside the OpenCode server process. Its `session.abort` / `session.status` calls through the plugin-provided `ctx.client` silently no-opped. The plugin now builds its own `@opencode-ai/sdk/v2` client pointed at the same server (`ctx.serverUrl`), the same client the rest of kimaki uses.

**2. Abort confirmation now polls session status instead of waiting on events.** The old implementation waited for `message.updated` (`MessageAbortedError`) and `session.idle` events to confirm the abort, but those events did not always reach the plugin, so it gave up after a long timeout. OpenCode's `cancel()` sets session status to idle synchronously during abort, so after calling `session.abort` the plugin now polls `session.status` until idle (usually one poll) and then replays the queued message.

This removes a large amount of hand-rolled event-correlation state (waiter set, pending-step boundary tracking, assistant-parent maps) in favor of a simple status poll, making mid-run interrupts deterministic.
