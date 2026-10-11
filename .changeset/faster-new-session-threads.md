---
'kimaki': patch
---

Create the thread of a new session sooner. The permission check reads the author's roles from the message itself instead of fetching the member from Discord, and the thread is created while the worktree, plugin, agent and model are still being set up. With automatic worktrees the thread now shows right away instead of after `git worktree add`. If setup fails, the empty thread is deleted and the error is posted as a reply to the message.
