---
"kimaki": patch
---

Fix spurious `✗ OpenCode API error: fetch failed` on long agent turns. The SDK fetch passed `timeout: false` (a Bun-only convention) which Node's fetch ignores, so dispatches ran on undici's default 300s headersTimeout; turns that take longer than 5 minutes before first response headers killed the dispatch with `TypeError: fetch failed` while the opencode server kept processing (the reply still arrived). On Node, SDK fetches now use an undici `Agent` with 15-minute header/body timeouts (override with `KIMAKI_SDK_FETCH_TIMEOUT_MS`); Bun behaviour is unchanged. Promotes undici from devDependency to dependency, replacing the hand-rolled `src/undici.d.ts` type stub with the package's real types.
