---
'kimaki': patch
---

Stop OpenCode server logs from leaking into terminals started by agent sessions.

Kimaki starts OpenCode with `--print-logs`, and OpenCode copies that flag into `OPENCODE_PRINT_LOGS=1` for every shell it spawns. Editors or `opencode` TUIs opened from an agent shell inherited it and printed lines like `level=WARN message="duplicate skill name"` over the TUI. Agent shells now get `OPENCODE_PRINT_LOGS=0`.
