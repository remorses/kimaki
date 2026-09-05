// Kimaki entry. Always on. Do not register this file as an OpenCode plugin
// module on its own; Kimaki re-exports the initializer.

import type { Plugin } from '@opencode-ai/plugin'
import { createAutoModePlugin } from './plugin.ts'

export const autoModeInternal: Plugin = createAutoModePlugin({ alwaysEnabled: true })
