---
'kimaki': patch
---

Delete one-time scheduled tasks after they run instead of keeping them as `completed` rows in the database. Cron tasks are unaffected and continue rescheduling as before.
