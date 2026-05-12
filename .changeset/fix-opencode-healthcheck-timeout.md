---
'kimaki': patch
---

Fix `kimaki` getting stuck forever at `Waiting for OpenCode server...` when the OpenCode server accepts the healthcheck TCP connection but never sends an HTTP response.

Kimaki now times out each startup healthcheck request and keeps polling, so the CLI can recover once OpenCode finishes initializing instead of hanging on the first request.

Fixes #123
