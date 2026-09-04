---
'kimaki': patch
---

Clean leftover `part_messages` rows when a Discord thread mapping is gone.

On startup Kimaki removes part-message rows left behind by a deleted thread mapping. New databases also cascade these rows when SQLite foreign-key enforcement is enabled.

Fixes #207
