---
'kimaki': patch
---

Restore the V1 message flags: bot messages no longer show link previews, and most of them no longer send notifications.

| message | link previews | notification |
| --- | --- | --- |
| model text, tool lines, banner, attachments, queue acks, echoes | hidden | silent |
| footer at the end of a run | hidden | yes |
| footer before each queued message starts | hidden | silent |
| errors, questions, permission requests, action buttons | hidden | yes |
| onboarding welcome, `kimaki send --notify-only` | hidden | yes |
| `kimaki send` envelopes to another machine | shown (they carry data) | silent |

The "Started a new session in #thread" reply no longer pings its author, and btw intros no longer resolve `@everyone` or user mentions from the prompt.

OpenCode V2 runs queued messages inside the same execution, so V2 showed one footer after the whole queue. Each answer now gets its own footer again, like V1:

```
slow-done
-# *project ⋅ main ⋅ 10s ⋅ 6% ⋅ gpt-6-luna*   (silent)
» tommy: queued message
apple
-# *project ⋅ main ⋅ 2s ⋅ 6% ⋅ gpt-6-luna*    (notifies)
```

Before, every V2 message pinged thread members and URLs in model output expanded into large embeds.
