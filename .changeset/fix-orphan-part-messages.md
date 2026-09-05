---
'kimaki': patch
---

Clean leftover `part_messages` rows when a Discord thread mapping is gone.

On startup Kimaki now deletes part rows whose `thread_sessions` parent no longer exists. New databases also cascade those rows when the mapping is deleted, so a wedged-session recovery `DELETE` cannot leave foreign-key violations behind.

Fixes #207
