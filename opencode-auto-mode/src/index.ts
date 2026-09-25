import { Plugin } from '@opencode/plugin'
import { createAutoModeSetup } from './plugin.ts'

export default Plugin.define({
  id: 'kimaki.auto-mode',
  setup: createAutoModeSetup({ alwaysEnabled: false }),
})
