---
'kimaki': minor
'website': patch
---

`kimaki session wait` now takes many sessions and says why each one returned.

```bash
kimaki session wait ses_abc 1495130000000000000 https://discord.com/channels/<guild>/<thread>

# wait for every other running session, in every project
kimaki session wait $(kimaki session list --all --active | awk '{print $1}')
```

It returns when all sessions are done, then prints each conversation in argument order. Each one starts with a header line that tells the agent if the work is really done:

```
=== ses_abc finished its run ===
=== ses_def is paused: it waits for the user to answer a question, so its work is not done ===
=== ses_ghi is paused: it showed buttons (Commit, Discard) and waits for the user to click one, so its work may not be done ===
```

Before, a session that ended its turn with `kimaki buttons` looked finished, so agents went on as if its work was done. `kimaki send --wait` prints the same header. With `--timeout`, sessions that still run get an `is still running after 30m` header and the command exits 1.

The agent instructions also warn that a session of one project can edit the folder of another project, so `session list --project <folder> --active` can miss it. Use `kimaki session list --all --active` to check if someone else is editing a repo.
