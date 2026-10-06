---
'kimaki': patch
---

Kimaki checks for OpenCode 2 before the Discord install, and installs it when no OpenCode exists.

- **Lookup order:** `OPENCODE_PATH` if set, else `opencode2`, `opencode`, then `~/.opencode/bin/opencode`. A running OpenCode 2 service is used as is.
- **OpenCode 1 found:** Kimaki stops and does not touch it:

  ```
  Kimaki now requires OpenCode 2, but opencode is OpenCode 1.15.5. Install OpenCode 2 with: curl -fsSL https://opencode.ai/v2/install | bash (or: npm i -g @opencode/cli). Then run kimaki again
  ```

- **No OpenCode at all:** Kimaki runs `curl -fsSL https://opencode.ai/v2/install | bash`. In a terminal it asks first. On Windows, or with `OPENCODE_PATH` set, it prints the install command instead.
