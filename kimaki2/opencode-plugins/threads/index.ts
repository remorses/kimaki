// Discord thread ↔ session ↔ directory map. Channel map comes from plugin options.

import { Plugin } from '@opencode-ai/plugin'
import { attachLocation, detachLocation } from './registry.ts'

export default Plugin.define({
  id: 'kimaki.threads',
  async setup(ctx) {
    const channels = ctx.options['channels']
    await attachLocation({
      directory: ctx.location.directory,
      ctx,
      channels: channels && typeof channels === 'object' ? channels : undefined,
    })
    return () => {
      detachLocation(ctx.location.directory)
    }
  },
})
