---
'kimaki': patch
---

Quote the new-session model banner in Discord.

When a thread starts, Kimaki still posts a silent `using provider/model ⋅ agent` status line. That line is now a Discord quote, same as the completion footer, so it stays visually secondary to the assistant reply.

```
> *using openai/gpt-5.6-sol ⋅ gpt5*
```
