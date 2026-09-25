---
'kimaki': patch
---

Make `. btw`, `/btw` and `/fork` forks reuse the source session's prompt cache, and start `. btw` faster.

Before this fix, a fork rebuilt the system prompt with its own session ID and thread ID, and it ran the default agent instead of the source agent. The provider saw a different prefix, so the fork processed its whole copied history again with no cache. On a 150k-token session, the first reply took about 11 seconds and cost a full cache write.

Now:

- **The system prompt is pinned for each session.** Kimaki makes it on the first turn and sends the same bytes on every later turn. Data that changes later goes into the per-turn context at the end of the user message. For example, a parent session added with `--parent-session` after the first turn is sent there.
- **A same-directory fork (`/btw`, `/fork`) reuses the pinned system prompt of its source.** The per-turn context tells the model that the fork has a new session ID and thread ID, and which IDs to use in kimaki commands. `/new-worktree` forks run in another directory, so OpenCode's environment block differs and they cannot share the cache.
- **A fork keeps the agent of its fork point**, not only the source model and variant. `/new-worktree` forks keep it too.
- **`. btw` starts sooner.** The fork and the Discord thread are created at the same time, setup steps run in parallel, and "Session forked!" appears before the prompt is sent. If one side fails, Kimaki removes the other.

Changes to the channel topic, the agent list, or Kimaki's prompt text now apply to new sessions only. Existing sessions keep their pinned system prompt, so their prompt cache stays valid.
