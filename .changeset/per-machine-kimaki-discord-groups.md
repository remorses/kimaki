---
'kimaki': minor
---

Give each Kimaki machine its own Discord group.

New project channels now go into a Discord category bound to this machine by snowflake id, stored in local SQLite. A second install in the same server creates another **Kimaki** group instead of sharing the first one. You can rename those groups; Kimaki still uses the stored id.

Existing installs adopt the parent of channels this machine already created, so current projects stay in their current group.
