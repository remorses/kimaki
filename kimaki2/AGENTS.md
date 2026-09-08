kimaki2 is OpenCode v2 Kimaki. One opencode2 process. Features are `Plugin.define` plugins.

Architecture: `docs/opencode-v2-kimaki-architecture.md`. Tests use the real OpenCode v2 tester (`PluginTestLayer` / `host()` from the `opencode-v2` submodule) or `opencode2 serve`. Do not add a fake Kimaki plugin host.

Real OpenCode plugins live in `opencode-plugins/` as directories and use `Plugin.define`. Prove load with `src/opencode2-load.e2e.test.ts` (isolated XDG, two folders, one PID).

`setup()` runs per location. Process singletons (Discord, sqlite) go on `globalThis` with a refcount.

Inbox `steer` / `queue` replace the v1 interrupt plugin. Do not abort and replay after 3s.

Filter `ctx.event.subscribe()` by `sessionID` / `location`. The bus is process-global.
