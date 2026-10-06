---
'kimaki': patch
---

Fix the first start after upgrading from Kimaki V1 asking for onboarding again.

Kimaki imports the V1 `~/.kimaki/discord-sessions.db` into `~/.kimaki/kimaki.db` on its first start. Two cases broke this:

- **A stray `kimaki.db` blocked the import.** Any existing file with that name counted as "already imported", so bot credentials and channels were not copied and onboarding started again. Kimaki now marks its own database (`PRAGMA user_version`). An unmarked `kimaki.db` (or a file that is not an SQLite database) next to a V1 database is renamed to `kimaki.db.unknown-<time>` (never deleted), then the import runs.
- **Rows pointing at deleted channels or threads failed the import.** V1 has no foreign keys on most tables, so real installs have scheduled tasks or channel settings for channels that no longer exist. The import now skips rows that need a missing channel or bot, and clears optional channel and thread references of scheduled tasks.

The V1 database is still opened read-only and never changed.
