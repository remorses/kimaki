// Example plugin that mutates the system prompt on every turn.
// Loaded before the drift detector so the example can force a prompt-cache bust
// and surface the detector toast in a reproducible local run.

import type { Plugin } from '@opencode-ai/plugin'

const alwaysUpdateSystemMessagePlugin: Plugin = async () => {
  const counts = new Map<string, number>()

  return {
    'experimental.chat.system.transform': async (input, output) => {
      const sessionId = input.sessionID
      if (!sessionId) {
        return
      }
      const nextCount = (counts.get(sessionId) || 0) + 1
      counts.set(sessionId, nextCount)
      output.system.push(`\n<system-reminder>Example system prompt mutation ${nextCount}</system-reminder>`)
    },
  }
}

export { alwaysUpdateSystemMessagePlugin }
