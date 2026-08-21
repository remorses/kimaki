import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import { setDataDir } from './config.js'

type SessionAwareHooks = Awaited<ReturnType<Plugin>> & {
  'shell.env': (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>
}

async function loadDatabaseModule() {
  return import('./database.js')
}

export const sessionAttributionPlugin = (async (
  _input: PluginInput,
): Promise<SessionAwareHooks> => {
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
}) satisfies Plugin
