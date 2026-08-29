---
'kimaki': patch
---

Fix `kimaki_sleep` on databases created before the sleep table dropped `thread_id`.

The first `session_sleeps` table required `thread_id`. A later change stopped writing that column, but `CREATE TABLE IF NOT EXISTS` left the old shape in place. Calling the tool then failed with `NOT NULL constraint failed: session_sleeps.thread_id`.

Startup now drops leftover `thread_id` and `posted_at` columns, and treats any old `posted` row as `planned` so it can still wake. Restart Kimaki once so the migration runs.
