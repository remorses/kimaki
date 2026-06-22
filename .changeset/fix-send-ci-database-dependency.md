---
'kimaki': patch
---

Fix `kimaki send` failing in CI/headless environments with "not configured with a project directory" errors.

Previously, `kimaki send --channel <id> --prompt "..."` always required a local SQLite database with channel-to-directory mappings (populated by the running bot during startup). This made it impossible to use from CI runners or GitHub Actions where no bot has ever synced locally.

Now the local project directory mapping is only required when features that genuinely need it are used (`--send-at`, `--wait`, `--cwd`). The basic flow (post message, create thread, let the remote bot pick it up) works with just `KIMAKI_BOT_TOKEN` and no local database state.
