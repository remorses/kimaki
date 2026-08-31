---
"kimaki": patch
---

<!-- ZAI 2026-08-31 -->
Prevent concurrent worktree creation from resetting existing branches or deleting another request's checkout, and keep dependency installation from modifying tracked lockfiles.

Fixes #202
