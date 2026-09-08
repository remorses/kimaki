// Inbox delivery plugin. Suffix queue → queue. Otherwise leave delivery unchanged.

import { Plugin } from '@opencode-ai/plugin'
import { extractQueueSuffix } from '../../src/queue-suffix.ts'

export default Plugin.define({
  id: 'kimaki.queue',
  async setup(ctx) {
    await ctx.session.hook('prompt', (event) => {
      const stripped = extractQueueSuffix(event.prompt.text)
      if (!stripped.forceQueue) return
      event.prompt.text = stripped.prompt
      event.delivery = 'queue'
    })
  },
})
