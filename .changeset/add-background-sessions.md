---
'kimaki': minor
---

Add `--background` to `kimaki send` and `kimaki task edit` for quiet automated sessions.

Discord only shows a thread in the left sidebar to its members, so every agent-spawned or scheduled thread that passed `--user` cluttered the sidebar — and the agent guidance told models to always pass `--user`. Routine automated work (daily digests, monitors, housekeeping) now has an explicit opt-out: `--background` creates the thread and runs the session exactly as before, but never adds anyone as a thread member. The thread stays public in its channel for later review, and replying in it still joins it naturally.

- `kimaki send --background` works for immediate sends and with `--send-at` (stored in the task payload so every cron fire stays background). Cannot be combined with `--user` or `--notify-only`.
- `kimaki task edit <id> --background true|false` flips existing tasks in place, so a noisy recurring task can go quiet without recreating it. `kimaki task list` marks background tasks with `(bg)` next to the userId column.
- The session system prompt now teaches agents to pick deliberately: `--user` for work the user should see and act on, `--background` for routine autonomous work.
