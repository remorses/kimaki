---
description: Upload files to Discord thread
---
Upload files to the current Discord thread by running:

```bash
npx -y kimaki upload-to-discord --session <sessionId> <file1> [file2] [file3] ...
```

Replace `<sessionId>` with your current OpenCode session ID (available in the system prompt).

Examples:

```bash
# Upload a single file
npx -y kimaki upload-to-discord --session ses_abc123 ./screenshot.png

# Upload multiple files
npx -y kimaki upload-to-discord --session ses_abc123 ./image1.png ./image2.jpg ./document.pdf
```

The session must have been sent to Discord first using `/send-to-kimaki-discord`.
