---
'kimaki': patch
---

Make `/<agent>-agent` without a prompt start a new thread in a coordinator channel.

Before, the command switched the coordinator session to that agent and model, so the next channel message ran the coordinator on the wrong agent. Now it creates a new thread session with that agent, which waits for your first message:

```
/thinker-agent              ─▶ new thread "Send a message to start working." (thinker agent)
/thinker-agent prompt:...   ─▶ new thread that runs the prompt (thinker agent)
```

The coordinator keeps its own agent and model. Inside a thread, and in channels with coordinator mode off, the command works as before: it switches the session agent or sets the channel default.
