---
'kimaki': patch
---

Fix question titles in Discord so they keep the full form title.

OpenCode v2 sends question headers as form field titles, for example **Select action**. Kimaki was slicing those titles to 12 characters, which dropped the last letter.
