---
'kimaki': patch
---

Load Kimaki Discord tools on OpenCode v2. `kimaki_sleep`, `kimaki_action_buttons`, and `kimaki_file_upload` now register from a plugin **directory**, which v2 requires. File plugins are ignored, so those tools used to fail with `Unknown tool`.
