---
'kimaki': patch
---

Fix source builds failing at startup because an unfinished analytics import
referenced a module that was never added to the package.
