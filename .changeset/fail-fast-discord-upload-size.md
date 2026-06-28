---
'kimaki': patch
---

Fail fast when uploading files that exceed Discord's size limit.

`uploadFilesToDiscord` now checks each file's size with `statSync` before reading it into memory. If a file exceeds the limit (25 MB default for bots, higher for boosted servers), it throws immediately with a clear error message instead of sending the request to Discord and waiting for a rejection.

The `maxFileSize` parameter can be passed to raise the limit for boosted guilds.
