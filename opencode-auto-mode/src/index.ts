// OpenCode auto-mode plugin. npm entry: only this export is a plugin.

import type { Plugin } from '@opencode-ai/plugin'
import { createAutoModePlugin } from './plugin.ts'

export const autoMode: Plugin = async (input, options) => {
  if (process.env.KIMAKI === '1') return {}
  return createAutoModePlugin({ alwaysEnabled: false })(input, options)
}
