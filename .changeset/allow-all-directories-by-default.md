---
'kimaki': minor
---

Allow the agent to access every directory by default, and remove `/add-dir`.

OpenCode's `external_directory` permission defaults to `ask`, so reading anything outside the project put an approval prompt in the thread. That prompt fired constantly for ordinary work (reading a sibling repo, a config file, a cached dependency), and if nobody clicked it within the permission timeout the tool call was rejected. Kimaki worked around it with a growing allow-list, an `/add-dir` command, and auto-granting directories from `#channel` mentions.

All of that is gone. **External directory access is now `allow` for every path.**

Kimaki writes `"external_directory": { "*": "allow" }` into its generated config. To protect specific folders, put `deny` or `ask` rules in your own `opencode.json`. Project config merges on top of that wildcard and the last matching rule wins, so your rules take priority while unlisted paths stay allowed:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "external_directory": {
      "~/.ssh": "deny",
      "~/.ssh/*": "deny",
      "~/Documents/*": "ask"
    }
  }
}
```

**New `--restrict-directories` flag** restores the old behaviour if you want it globally:

```bash
kimaki --restrict-directories
```

The agent is then limited to the session working directory plus a few known-safe paths (`/tmp`, `~/.config/opencode`, `~/.opensrc`, `~/.kimaki`, and common toolchain caches). Everything else asks for approval in the thread.

**Removed:**

- `/add-dir` slash command. It only existed to widen a session past the `ask` default, which no longer applies.
- Auto-granting a referenced project's directory when you mention `#channel` in a message. Mentions still resolve normally; they just no longer carry permission side effects.

Worktree threads still deny the original checkout with or without the flag. That rule is directory isolation, not prompt avoidance: it keeps the agent from editing the main repo after the thread moved to a worktree. It is applied at session level so it also beats your `opencode.json`; only an explicit `--permission 'external_directory:allow'` on that session can override it.
