---
'kimaki': patch
---

`/abort` now also clears the thread's `/queue`, like `/clear-queue` does.

Before, queued messages survived an abort. They were sent right after the abort, or restored from SQLite and sent after a Kimaki restart. Now abort removes them from memory and from the database, and the reply says how many were dropped:

```
Request **aborted**, cleared 2 queued messages
```
