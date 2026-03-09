# Memory

- Platform adapter migration: shared platform types should not expose `raw` or
  `discord.js` shapes. If shared code needs a new behavior, add it to the
  adapter contract explicitly.
- Prefer a resource-oriented adapter API over a flat bag of functions:
  `adapter.channel(id)`, `adapter.thread(id)`, `adapter.conversation(target)`,
  and message/thread handles with fluent operations.
- Group platform-specific capabilities under structured namespaces such as
  permissions, command metadata, uploads, mentions, and voice instead of adding
  ad hoc methods to event objects.
