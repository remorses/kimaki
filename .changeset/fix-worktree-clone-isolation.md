---
'kimaki': patch
---

Fix worktree creation when two registered projects are independent clones of the same remote.

Kimaki now binds each workspace request to the exact registered checkout and a resolved commit SHA. Before starting a session, it verifies that the new worktree shares the requested checkout's Git common directory and has the requested commit checked out. A mismatch is removed and reported instead of starting a session in the wrong repository.
