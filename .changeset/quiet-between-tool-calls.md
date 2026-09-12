---
'kimaki': patch
---

Ask agents to stay quiet between tool calls.

Discord posts every text part, so narration like "I'll read the file" cluttered threads. The system prompt now tells the model to be concise, skip commentary between tools, and only write the final answer for the turn (except tools that require text first, like `question` and `kimaki_sleep`).
