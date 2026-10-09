---
'kimaki': patch
---

`kimaki upload-to-discord` now waits until Discord has the files and reports failures to the agent, like V1. Before, it printed success at once even when the upload failed later.

```bash
kimaki upload-to-discord ./missing.png
# File not found: /path/to/missing.png   (exit code 1)
```

- missing paths fail before anything is posted
- Discord errors (for example a file over the server upload limit) are returned with the file names
- files are split into messages of at most 10 files and about 24 MiB, below Discord's 25 MiB request limit, so many screenshots no longer fail as one oversized request
