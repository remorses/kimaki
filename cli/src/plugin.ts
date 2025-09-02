import type { Plugin } from '@opencode-ai/plugin'
import { logger } from './file-logger.js'

export const MyPlugin: Plugin = async ({
  project,
  client,
  $,

  directory,
  worktree,
}) => {
  let sessionId = ''

  logger.log('plugin function called')
  return {
    async event({ event }) {
      if (event.type === 'message.part.updated') {
        const part = event.properties.part

        const messages = await client.session.messages({
          path: { id: part.messageID },
        })
      }
      if (event.type === 'session.updated') {
        sessionId = event.properties.info.id
        logger.log(`session.updated ${sessionId}`)
      }
      if (event.type === 'session.idle') {
        sessionId = event.properties.sessionID
        logger.log(`session.idle ${sessionId}`)
      }
    },
  }
}
