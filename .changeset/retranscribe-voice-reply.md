---
'kimaki': minor
---

**Reply `retranscribe` to a voice message to handle it again.** A voice message sent while the bot was not running gets no reply, so there is no Retry button to click. Reply to it with the single word `retranscribe` and Kimaki transcribes it and routes it like a new voice message (steer, queue, btw or new session), with the usual transcript echo. The word itself is never sent to the agent. A `retranscribe` reply to a message without audio stays a normal text prompt.

```
voice message (0:24)          ← sent while the bot was down
  ↳ retranscribe              ← your reply
-# » you: <transcript>        ← Kimaki echoes it and runs the prompt
```

Thanks to @Xipzer for the implementation.

Closes #263
