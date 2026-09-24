---
'kimaki': patch
---

Show the `prompt cache missed` notice for every real cache miss, right after the first reply to a new user message.

Before, many misses were hidden:

- the check used the **last** reply of a turn, which already reads back the cache that the turn wrote
- on Anthropic, the message after a miss only reports `cache.write`, so a second miss in a row (or a miss on the second message of a session) was skipped
- an aborted or failed reply between two messages hid the notice for the next message
- any prompt that got a bit smaller was treated as pruning, even when nothing was pruned

Now the first reply of each message is compared with the cached prefix (`cache.read + cache.write`) of the last good reply. Aborted replies are skipped. Only real pruning and compaction still hide the notice. A reverted, shorter prompt is compared with its own length, so `/undo` does not show a false miss. The first message of a session still shows nothing, since there is no cache yet.
