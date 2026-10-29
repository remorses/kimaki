// Test plugin: appends the session ID of every `generate` request (keep-alives)
// to generate.log next to the project directory, so tests can count them.

import fs from 'node:fs'
import path from 'node:path'
import { Plugin } from '@opencode/plugin'

export default Plugin.define({
  id: 'kimaki-test-generate-log',
  async setup(ctx) {
    const file = path.join(ctx.location.directory, '..', 'generate.log')
    await ctx.session.hook('generate', async (event) => {
      await fs.promises.appendFile(file, `${event.sessionID}\n`)
    })
  },
})
