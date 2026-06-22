---
'kimaki': patch
---

Fix workspace-managed worktree setup and cleanup.

Worktree creation now parses standard indented `.gitmodules` files inside the plugin-safe workspace adaptor, so submodules initialize correctly when Kimaki creates an OpenCode-managed worktree.

Deleting a Kimaki worktree from `/worktrees` now removes the matching OpenCode workspace record through the workspace SDK before deleting Kimaki's local thread mapping. This keeps OpenCode workspace state, git worktrees, and Kimaki thread metadata in sync.
