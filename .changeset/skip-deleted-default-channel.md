---
'kimaki': patch
---

Stop recreating the default kimaki channel if the user previously deleted it.

A `guild_id` column on `channel_directories` now scopes mappings per guild.
When the default channel is deleted, its `channel_directories` row is preserved
as a tombstone. On next startup, kimaki sees the stale row for this guild and
skips recreation. Multi-guild setups are handled correctly since each guild
has its own scoped row.
