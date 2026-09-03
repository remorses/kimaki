---
'kimaki': patch
---

Agents can omit `--user` when scheduling work that should stay out of the Discord sidebar. `kimaki task edit --user ''` now clears a stored user on an existing task.

```bash
# quiet recurring work: nobody is added as a thread member
kimaki send --channel <id> --prompt 'Read tasks/daily-digest.md' --send-at '0 21 * * *'

# stop notifying someone on an existing task without deleting it
kimaki task edit 11 --user ''
```

`--user` still adds the person to the thread so it shows in their sidebar. A `-` in `kimaki task list` still means nobody is added when the task fires.
