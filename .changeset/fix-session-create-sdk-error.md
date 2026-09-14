---
'kimaki': patch
---

Show the OpenCode SDK error when session create fails.

Kimaki used to say `session.create returned empty data` even when OpenCode sent `UnknownError` in the response body. Discord now shows that error, including the OpenCode log ref.

```
Failed to create session: UnknownError: Unexpected server error. Check server logs for details. (err_58d6c6cf)
```
