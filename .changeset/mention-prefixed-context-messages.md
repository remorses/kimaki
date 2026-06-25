---
'kimaki': minor
---

Add mention-prefixed messages to session context without triggering AI response.

When a user sends a message in a thread that starts with an `@mention` to another user (not the bot), the message is now added to the OpenCode session context via `promptAsync` with `noReply: true`. Previously these messages were fully ignored. Now the agent sees user-to-user conversation on the next real turn, giving it better context about the discussion.

This only applies to thread messages. Channel-level messages with leading mentions to other users are still fully ignored (no thread creation). Context-only messages also don't cancel pending permissions, questions, or action buttons, and don't trigger typing indicators.
