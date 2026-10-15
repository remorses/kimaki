---
'kimaki': patch
---

Fix autostart on Node 22. The bot crashed with `SyntaxError: Unexpected identifier 'cleanup'` because the build kept native `await using` syntax, which Node 22 cannot parse. The build now compiles it down.

The autostart window also explains why it opened: OpenCode started, no Kimaki bot was running, so the Kimaki plugin started the Discord bot. It prints the Node binary in use and how to stop the bot. When the Node that last ran the bot was removed (for example by a version manager), autostart now falls back to `node` from `PATH`.
