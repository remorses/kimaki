// OpenCode plugin that injects onboarding tutorial system instructions.
// Detects TUTORIAL_WELCOME_TEXT in any text part of the session (the thread
// starter content appears in the user prompt via "Context from thread:..."
// prepended by message-preprocessing.ts). When found, injects
// ONBOARDING_TUTORIAL_INSTRUCTIONS as a synthetic system-reminder.
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
import {
  ONBOARDING_TUTORIAL_INSTRUCTIONS,
  TUTORIAL_WELCOME_TEXT,
} from './onboarding-tutorial.js'

const logger = createLogger(LogPrefix.OPENCODE)

const onboardingTutorialPlugin: Plugin = async () => {
  // Track sessions where tutorial instructions have been injected.
  // Once injected, never inject again for the same session.
  const sessionTutorialInjected = new Set<string>()

  return {
    'chat.message': async (input, output) => {
      const hookResult = await errore.tryAsync({
        try: async () => {
          const { sessionID } = input
          if (sessionTutorialInjected.has(sessionID)) {
            return
          }

          // Check ALL text parts (including system/synthetic) for the
          // welcome text. The thread starter content is prepended to the
          // user prompt by message-preprocessing.ts as "Context from thread:".
          const hasTutorialContext = output.parts.some((part) => {
            return part.type === 'text' && part.text.includes(TUTORIAL_WELCOME_TEXT)
          })
          if (!hasTutorialContext) {
            return
          }

          sessionTutorialInjected.add(sessionID)

          // Use messageID from the first text part for the synthetic injection
          const firstText = output.parts.find((part) => {
            return part.type === 'text'
          })
          if (!firstText) {
            return
          }

          output.parts.push({
            id: `prt_${crypto.randomUUID()}`,
            sessionID,
            messageID: firstText.messageID,
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
