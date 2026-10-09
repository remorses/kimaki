---
'kimaki': patch
---

Keep the prompt cache when the session moves or the git branch changes.

The Kimaki plugin used to add `[current working directory is ...]` and `[current git branch is ...]` to the system prompt of every request. A `kimaki session cwd` move or a branch switch changed that text, so the provider re-read the whole conversation without cache.

```
before: [tools][system + cwd + branch][history ..........]   branch change: all history uncached
after:  [tools][system (stable)      ][history ...][branch]   branch change: only the new prompt
```

- The directory line is removed. OpenCode already sends it in its environment instructions, and adds a change notice at the end of the history on a move.
- The branch is now a synthetic message saved right before the user prompt, only when the branch is different from the last one the model saw.
