# Changelog

## 0.0.3

### Bug Fixes

- **Binary WebSocket support** - Binary messages are now properly forwarded via base64 encoding. Previously binary messages were silently dropped.
- **Non-JSON WebSocket messages** - Plain text WebSocket messages are now forwarded correctly. Previously only JSON messages worked.
- **Preview URL pattern** - Fixed regex to handle both production (`*-tunnel.`) and preview (`*-tunnel-preview.`) URL patterns.
- **CLI executable permissions** - Build script now sets executable flag on `dist/cli.js`.

### Features

- **Preview deployment environment** - Added preview environment config in `wrangler.json` for testing before production.

### Improvements

- **Node.js 18+ required** - Added `engines` field requiring Node.js >= 18.0.0 (for native fetch).
- **Separate build/test tsconfig** - Test files are no longer compiled to dist.

### Tests

- Added 28 comprehensive integration tests covering:
  - HTTP methods (GET/POST/PUT/DELETE/PATCH)
  - Large request/response bodies (50KB/100KB)
  - Binary data transfers
  - Concurrent requests
  - SSE streaming
  - WebSocket connections (text, binary, broadcast, concurrent)
  - Offline tunnel behavior
  - Upstream reconnection

## 0.0.2

- Initial release with HTTP tunneling, WebSocket proxy, and SSE streaming support.
