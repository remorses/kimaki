---
'kimaki': patch
---

The footer at the end of a turn no longer shows the branch when the session is on the repo's default branch. Other branches still show.

```
-# *main ⋅ 2m 30s ⋅ 71% ⋅ claude-opus-5-5*        <- before
-# *2m 30s ⋅ 71% ⋅ claude-opus-5-5*               <- now, on main
-# *fix-login ⋅ 40s ⋅ 12% ⋅ claude-opus-5-5*      <- on another branch
```

The default branch is the one `origin/HEAD` points to, else a local `main` or `master`. Kimaki reads it once per folder and keeps it in memory, so footers do not run the lookup again.
