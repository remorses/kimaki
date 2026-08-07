import type { Plugin } from '@opencode-ai/plugin'
import { setDataDir } from './config.js'

async function loadDatabaseModule() {
  return import('./database.js')
}

export const sessionAttributionPlugin: Plugin = async () => {
  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) setDataDir(dataDir)
  let databaseModule: ReturnType<typeof loadDatabaseModule> | undefined

  return {
    'shell.env': async ({ sessionID }, output) => {
      if (!sessionID) return

      try {
        databaseModule ??= loadDatabaseModule()
        const { getThreadIdBySessionId } = await databaseModule
        const threadId = await getThreadIdBySessionId(sessionID)
        if (threadId) output.env.KIMAKI_THREAD_ID = threadId
      } catch {
        // Manual OpenCode sessions and unavailable Kimaki state remain unattributed.
      }
    },
  }
}
