---
'kimaki': patch
---

Enrich `kimaki session list` with status, token footprint, and cross-project listing.

- Every row now shows `status: working` or `status: idle`, not just with `--active`.
- Rows show `tokens: N` (total token footprint) when available, read straight from the session object so the command stays fast (no message fetching).
- New `--all` flag lists sessions across every locally registered project.
- Session titles and Discord `thread` IDs are still shown; `--json` output gains `status`, `model`, and `tokens`.

```
ses_abc | Fix auth timeout | /path/to/repo | 2026-01-01T00:00:00Z | (kimaki) | status: working | tokens: 84k | thread: 123456789012345678
```
