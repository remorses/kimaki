---
'kimaki': minor
---

Merge upstream/main (kimaki@0.15.0, kimaki@0.16.0) into fork.

Notable upstream changes:
- Add `kimaki session abort` command for aborting OpenCode sessions from CLI
- Add `kimaki send --notify-only` support for arbitrary Discord channels (not just project channels)
- Enable gateway mode option in onboarding wizard
- Filter disabled skills from Discord slash command registration
- Parallelize async operations in /btw and /new-worktree commands
- Show clickable source thread link in fork/btw new thread messages
- Split long --notify-only messages instead of attaching as file
- Fix: use sdkDirectory for all OpenCode client lookups
- Fix: self-restart on gateway reconnect limit with concurrent-call guard
- Fix: skip thread creation for notify-only on non-project channels
- Fix: wait 200ms before sending followup prompt after subagent abort
- Fix: dismiss stale permission buttons when plugin auto-rejects
