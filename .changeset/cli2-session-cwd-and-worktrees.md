---
'kimaki-cli2': minor
---

Add first-class session working directories and custom Git worktrees to the V2 rebuild.

- Show or change cwd with `/cwd` and `kimaki session cwd [directory]`. OpenCode applies moves at a safe boundary; file tools, commands, footers, forks and restart recovery use the current session location.
- Create isolated sessions with `/new-worktree` or `send --worktree [name] --base-branch <ref>`. Inside a thread, `/new-worktree` forks history without moving the source session.
- List and remove safe checkouts through `/worktrees` and `worktree list/remove`; merge locally with `/merge-worktree` or `worktree merge --strategy rebase|squash`.
- Enable automatic worktrees through `/worktrees`, `channel worktrees on`, or the root `--worktrees` flag. Recurring worktree tasks receive a fresh checkout each time.

Creation uses the exact Git clone and committed HEAD, never resets existing branches, and installs dependencies with frozen lockfiles. Merge and deletion preserve branch refs; deleting a checkout does not move its existing sessions. Use `/cwd` to choose another directory.
