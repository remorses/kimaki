---
'kimaki': patch
'website': patch
---

Stop agents from treating a `kimaki_sleep` tool result as a wake.

The old result said **Stop now. You will be woken with a new message.** Models kept going and pretended the wait was over. The result now says:

- this is **not** a wake
- write one short waiting line, then stop
- keep waiting until a later Discord message that starts with **Woke after sleeping until**
- a new user message cancels the sleep. If the later wake is still needed, call `kimaki_sleep` again with the original `until` time
