import { Plugin } from '@opencode/plugin'
import { createAutoModeSetup } from './plugin.ts'

export const autoModeInternal = Plugin.define({
  id: 'kimaki.auto-mode.internal',
  setup: createAutoModeSetup({ alwaysEnabled: true }),
})
