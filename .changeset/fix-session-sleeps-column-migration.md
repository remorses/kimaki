---
'kimaki': patch
---

Stop the task runner from failing every 5 seconds on databases created before the sleep delivery columns existed.

`session_sleeps` gained `delivery_id`, `attempts`, and `last_attempt_at` after the first sleep table shipped. Existing Kimaki installs kept the old table because `CREATE TABLE IF NOT EXISTS` does not add columns. The runner then queried `last_attempt_at` on every tick and logged `Task runner tick failed`.

Startup now adds the missing columns and backfills `delivery_id`. Restart Kimaki once so the migration runs.
