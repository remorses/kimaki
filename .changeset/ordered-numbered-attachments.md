---
'kimaki': minor
---

Keep file and image order exact, so the user and the agent can point at "image 2".

`kimaki upload-to-discord` now takes many files in one call and posts them in argument order. Images and other files no longer get regrouped by the Discord client: each upload is a Components V2 message with one media item or file card per argument, and with more than one file each gets a numbered label.

```bash
kimaki upload-to-discord before.png report.pdf after.png
```

```
-# 1. `before.png`
[image]
-# 2. `report.pdf`
[file card]
-# 3. `after.png`
[image]
```

Files a user attaches to a Discord message now reach the model as one numbered `<attachments>` list in the order they were attached (inline images included), instead of a list of only the files the model could not see inline. The agent instructions tell agents to batch uploads into one command and to use these numbers.
