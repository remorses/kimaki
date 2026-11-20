---
'kimaki': patch
---

Claude Pro/Max requests now upload much less data on every model step.

OpenCode sends the whole conversation as plain JSON on every step, with every image and PDF inlined as base64. A session with screenshots re-sends megabytes each time. The Kimaki Anthropic plugin now changes subscription requests to `api.anthropic.com` in two ways:

- **Files API**: each image and PDF is uploaded once and referenced by its `file_id` afterwards. Uploads expire after 7 days and are uploaded again when a session outlives them. The prompt cache keys on the file content, so this costs no cache miss. If a file was deleted, the failed request is retried and uploads it again. If uploads fail (for example a full storage quota), requests keep sending base64 and uploads pause for 5 minutes.
- **gzip**: the request body is gzip-compressed. Anthropic rejects zstd and brotli. A 420 KB prompt is sent as about 1 KB.

Requests with an API key and requests to a custom base URL (proxies) are not changed. If you set `encoding: "gzip"` on the Anthropic provider yourself, the plugin now reads the compressed body correctly instead of skipping the Claude Code identity rewrite.
