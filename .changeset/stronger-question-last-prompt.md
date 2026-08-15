---
'kimaki': patch
---

Make the system prompt require `question`, `kimaki_action_buttons`, and `kimaki_file_upload` to run last, after all text.

Calling these tools first hid the assistant message behind Discord dropdowns and buttons.
