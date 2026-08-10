---
'kimaki': patch
---

Keep raw Discord user IDs separate from usernames when `kimaki send --user` and `kimaki task edit --user` create session metadata. Kimaki now includes `userId` without inventing a numeric `username` when only an ID or mention is available.
