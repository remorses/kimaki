---
'kimaki': patch
---

Restore the V1 message flags: bot messages no longer show link previews, and most of them no longer send notifications.

| message | link previews | notification |
| --- | --- | --- |
| model text, tool lines, banner, attachments, queue acks, echoes | hidden | silent |
| footer at the end of a turn | hidden | yes, unless more input is queued |
| errors, questions, permission requests, action buttons | hidden | yes |
| onboarding welcome, `kimaki send --notify-only` | hidden | yes |

Before, every V2 message pinged thread members and URLs in model output expanded into large embeds.
