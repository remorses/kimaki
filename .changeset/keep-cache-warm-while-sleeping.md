---
'kimaki': patch
---

A session that runs `kimaki sleep` for **45 minutes or less** now keeps its prompt cache warm until the wake, with the same keep-alive requests the coordinator uses while its workers run (one every 4 minutes). The wake then reads the cached prompt instead of writing it again. Longer sleeps let the cache expire.
