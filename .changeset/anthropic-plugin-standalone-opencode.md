---
'kimaki': patch
---

Use the Claude Pro/Max login plugin in plain OpenCode, without the bot. The `kimaki-anthropic` plugin now lives in its own folder, so OpenCode can load it from `opencode.json`:

```jsonc
{
  "plugins": ["/path/to/node_modules/kimaki/dist/plugin/anthropic"]
}
```

When the bot starts and the global `opencode.json` already lists this folder (from any Kimaki install), it removes its own `plugins/kimaki-anthropic/` shim. The plugin is loaded once, and OpenCode no longer shows `1 plugin failed` with `Duplicate plugin ID: kimaki-anthropic`.

Claude Pro/Max now has two login methods:

| Method | Flow |
|---|---|
| **Claude Pro/Max (browser)** | Authorize in the browser. The `localhost:53692` callback finishes the login, no paste step. |
| **Claude Pro/Max (headless)** | For a browser on another machine (for example Discord `/login` with the bot on a server). Paste the URL of the last page. |
