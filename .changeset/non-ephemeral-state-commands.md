---
'kimaki': patch
---

Make state-changing slash commands non-ephemeral so all users in the channel see them.

Commands affected: `/upgrade-and-restart`, `/abort`, `/undo`, `/redo`, `/restart-opencode-server`.

Previously these used `SILENT_MESSAGE_FLAGS` (SuppressEmbeds + SuppressNotifications) on `deferReply`, making replies invisible to other users browsing the thread. Now replies are fully visible and trigger normal Discord notifications.

Error replies remain ephemeral since they're only relevant to the invoking user.
