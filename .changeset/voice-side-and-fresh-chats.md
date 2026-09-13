---
'kimaki': minor
---

Route voice messages into separate chats with OpenAI or Gemini transcription:

- Explicitly ask to create a side chat or fork to copy the current conversation into a separate thread with its context. This requires an existing session.
- Say "create this as a new chat session" to start a separate thread without conversation history.

Routing instructions are removed from the transcription. The actual request goes only to the destination chat. Explicit agent selection also works with either route. Voice messages sent in a project channel already start a fresh thread.
