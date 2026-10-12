// Tells the model its own OpenCode session ID, in every session (TUI, Discord, subagents).
//
// The ID never changes in a session, so the system text is the same on every
// request and the provider prompt cache keeps hitting.
//
// Standalone in plain OpenCode without the bot: list this directory in
// opencode.json `plugins`. The bot then skips its shim, see installPluginShim
// in opencode-server.ts. It imports nothing from Kimaki outside this folder.

import { Plugin } from '@opencode/plugin'

export default Plugin.define({
  id: 'kimaki-session-id',
  async setup(ctx) {
    await ctx.session.hook('context', (event) => {
      event.system.push({ type: 'text', text: `OpenCode session ID: ${event.sessionID}` })
    })
  },
})
