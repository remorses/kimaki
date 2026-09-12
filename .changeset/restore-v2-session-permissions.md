---
'kimaki': patch
---

Restore per-session `--permission` overrides with OpenCode V2. Apply rules when a session starts and wait for explicit replacements before sending the next prompt. Ordinary follow-up messages retain existing and inherited rules.

Use native V2 action names, for example `--permission 'shell:git *:ask'` or `--permission 'edit:src/*:deny'`. Saved approvals can satisfy `ask`; a matching `deny` still blocks access.

Apply original-checkout read/edit restrictions when creating or moving into a worktree, including the relative file paths used by OpenCode. These file-tool rules are not a filesystem sandbox for shell commands.

Keep permission buttons scoped to the requesting session and saved-approval scope, and disable Accept Always when OpenCode supplies no save scope.

Requires an OpenCode V2 client and server release containing anomalyco/opencode#48351. Related to #220.
