---
'kimaki': minor
---

Archive thread now syncs to OpenChamber. When archiving a Discord thread, the session is now marked as archived in OpenCode via `session.update({ time: { archived: timestamp } })`, so it appears under the "Archived" filter in OpenChamber's sidebar.
