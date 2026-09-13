---
'kimaki': patch
---

Make `kimaki project add` fail when the folder is already registered.

If the same project directory is already mapped to a Discord channel, the command now exits with a non-zero code instead of creating another channel.

```sh
kimaki project add /path/to/repo
# Channel already exists for this directory: /path/to/repo
# Channel ID: 123
# Remove the mapping first: kimaki project remove 123
```
