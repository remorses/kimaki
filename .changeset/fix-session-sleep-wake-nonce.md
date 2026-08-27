---
'kimaki': patch
---

Fix `kimaki_sleep` wake messages being rejected by Discord because their nonce exceeded Discord's 25-character limit.

Sleeping remains non-blocking. The current turn can finish normally, and Kimaki starts a new turn when the configured wake time arrives.
