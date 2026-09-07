---
'kimaki': patch
'website': patch
---

Fix explicit voice chat creation without interrupting the source session.

- Require an explicit request to create a new chat, session, or thread. Conversational phrases such as "by the way" no longer trigger a side chat.
- Start plain new-chat requests without history. Offer contextual side chats and forks only when a source session exists.
- Keep pending questions, permissions, and action buttons in the source chat when a voice request goes elsewhere.
- Keep long request overflow inside the destination thread, not the parent channel. Preserve typed captions, attachments, the complete transcribed model request, and its voice prefix.
- Preserve workspace metadata for contextual forks across restarts, and confirm fresh thread creation before sending the request.
- Report unsupported routes and empty requests without starting an unintended turn. Keep the transcript visible so the request can be retried.

Update the voice guide with queueing, explicit chat creation, and transcription-provider limits.
