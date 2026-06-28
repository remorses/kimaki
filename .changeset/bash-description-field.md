---
'kimaki': patch
---

Add `description` field to bash tool system prompt instructions so models always send a short summary with each bash call. The field is shown in Discord as context for what the command does. Also restructured the bash tool instructions as a TypeScript interface so models are more likely to follow the schema.
