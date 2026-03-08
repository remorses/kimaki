// OpenCode plugin that injects onboarding tutorial system instructions.
// Detects the tutorial prompt (from onboarding-welcome.ts) in the first user
// message of a session and injects ONBOARDING_TUTORIAL_INSTRUCTIONS as a
// synthetic system-reminder part so the model knows how to guide the 3D game build.
//
// Exported from opencode-plugin.ts — each export is treated as a separate
// plugin by OpenCode's plugin loader.

import type { Plugin } from '@opencode-ai/plugin'
import crypto from 'node:crypto'
import * as errore from 'errore'
import {
  createLogger,
  formatErrorWithStack,
  LogPrefix,
} from './logger.js'
import { notifyError } from './sentry.js'
import { ONBOARDING_TUTORIAL_INSTRUCTIONS } from './onboarding-tutorial.js'

const logger = createLogger(LogPrefix.OPENCODE)

// Must match TUTORIAL_PROMPT in onboarding-welcome.ts. Hardcoded because
// importing from onboarding-welcome.ts would pull in discord.js deps that
// aren't available in the OpenCode plugin process.
const TUTORIAL_PROMPT_SUBSTR = 'Build a 3D game with Three.js'

const onboardingTutorialPlugin: Plugin = async () => {
  const sessionTutorialInjected = new Set<string>()

  return {
    'chat.message': async (input, output) => {
      const hookResult = await errore.tryAsync({
        try: async () => {
          const first = output.parts.find((part) => {
            if (part.type !== 'text') {
              return true
            }
            return part.synthetic !== true
          })
          if (!first || first.type !== 'text' || first.text.trim().length === 0) {
            return
          }

          const { sessionID } = input
          if (sessionTutorialInjected.has(sessionID)) {
            return
          }
          if (!first.text.includes(TUTORIAL_PROMPT_SUBSTR)) {
            return
          }

          sessionTutorialInjected.add(sessionID)

          output.parts.push({
            id: crypto.randomUUID(),
            sessionID,
            messageID: first.messageID,
            type: 'text' as const,
            text: `<system-reminder>\n${ONBOARDING_TUTORIAL_INSTRUCTIONS}\n</system-reminder>`,
            synthetic: true,
          })
        },
        catch: (error) => {
          return new Error('onboarding tutorial hook failed', { cause: error })
        },
      })
      if (hookResult instanceof Error) {
        logger.warn(
          `[onboarding-tutorial-plugin] ${formatErrorWithStack(hookResult)}`,
        )
        void notifyError(hookResult, 'onboarding tutorial plugin hook failed')
      }
    },

    event: async ({ event }) => {
      if (event.type !== 'session.deleted') {
        return
      }
      const id = event.properties?.info?.id
      if (id) {
        sessionTutorialInjected.delete(id)
      }
    },
  }
}

export { onboardingTutorialPlugin }
