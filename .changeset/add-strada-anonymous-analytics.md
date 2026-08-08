---
'kimaki': minor
---

Add anonymous usage analytics via Strada so install activity, projects, sessions, and turns can be measured without collecting personal data.

Kimaki stores a random install id in `~/.kimaki/install-id` (or your `--data-dir`) and emits product events only:

- `bot_started` when the Discord bot is ready
- `project_registered` when a project channel is mapped (`user` vs `default`)
- `session_created` when a new OpenCode session is created
- `turn_started` when OpenCode accepts a prompt or command (with `source` so retries can be excluded from DAU)
- `turn_completed` on natural visible completions

No Discord IDs, paths, prompts, or secrets are sent. Metrics are **active installs**, not people.

Disable with `kimaki --no-analytics` or `KIMAKI_STRADA_ENABLED=0`. Override the default project with `KIMAKI_STRADA_PROJECT_ID` / `KIMAKI_STRADA_TOKEN` for local debugging.

The website also reports server and browser errors to the same Strada project.
