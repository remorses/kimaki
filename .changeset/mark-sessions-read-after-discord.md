---
'kimaki': patch
---

Mark sessions as read in OpenCode after their output is posted to Discord.

Kimaki sessions no longer show as unread in the OpenCode TUI tabs and app sidebar after you already read the answer in Discord. When a run ends (success, failure or interrupt), Kimaki posts the last lines, then calls `session.view` for that run.

Discord does not expose read state to bots, so "posted to the thread" is used as "read".
