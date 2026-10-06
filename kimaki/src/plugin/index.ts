import { Plugin } from '@opencode/plugin'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

import { fileEditTool, recordToolEdits } from '../file-edit-log.ts'

const exec = promisify(execFile)

export default Plugin.define({
  id: 'kimaki',
  async setup(ctx) {
    async function marker(sessionID: string) {
      const session = await ctx.session.get({ sessionID }).catch(() => null)
      const value: unknown = session?.metadata?.['kimaki']
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const current = new Map(Object.entries(value))
      if (!session?.parentID) return current
      const parent = await ctx.session.get({ sessionID: session.parentID }).catch(() => null)
      const parentMarker = parent?.metadata?.['kimaki']
      if (parentMarker && typeof parentMarker === 'object' && !Array.isArray(parentMarker) && parentMarker['threadId'] === current.get('threadId')) return marker(session.parentID)
      return current
    }
    await ctx.session.hook('context', async (event) => {
      if (!(await marker(event.sessionID))) return
      event.system.push({ type: 'text', text: `[current working directory is ${ctx.location.directory}]` })
      const branch = await exec('git', ['branch', '--show-current'], { cwd: ctx.location.directory, timeout: 5000 }).catch(() => null)
      if (branch?.stdout.trim()) event.system.push({ type: 'text', text: `[current git branch is ${branch.stdout.trim()}]` })
      // Extra inputs only for the Discord tool line. OpenCode decodes the real
      // inputs with Schema.Struct, which ignores unknown keys.
      const description = { type: 'string', description: 'Short 5-10 word summary shown in Discord' }
      const extras = {
        shell: { description, hasSideEffect: { type: 'boolean', description: 'True if the command writes files, modifies state, or triggers external effects' } },
        execute: { description },
      }
      for (const [name, properties] of Object.entries(extras)) {
        const tool = event.tools[name]
        const input = tool?.input
        if (!tool || !input || typeof input !== 'object' || Array.isArray(input)) continue
        tool.input = { ...input, properties: {
          ...(input.properties && typeof input.properties === 'object' ? input.properties : {}),
          ...properties,
        } }
      }
    })
    await ctx.tool.hook('execute.before', async (event) => {
      if (event.tool !== 'shell' || !event.input || typeof event.input !== 'object' || Array.isArray(event.input)) return
      const info = await marker(event.sessionID)
      const dataDir = info?.get('dataDir')
      const lockPort = info?.get('lockPort')
      if (typeof dataDir !== 'string' || typeof lockPort !== 'number') return
      if (!('command' in event.input) || typeof event.input.command !== 'string') return
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      event.input.command = `export PATH=${quote(path.join(dataDir, 'bin'))}:"$PATH" KIMAKI_DATA_DIR=${quote(dataDir)} KIMAKI_LOCK_PORT=${quote(String(lockPort))} KIMAKI_TOOL_CALL=${quote(`${event.messageID}:${event.id}`)}; ${event.input.command}`
    })
    // File edits feed `kimaki session editors` (v1-compatible JSONL index).
    await ctx.tool.hook('execute.after', async (event) => {
      if (event.status !== 'completed' || !fileEditTool(event.tool)) return
      const dataDir = (await marker(event.sessionID))?.get('dataDir')
      if (typeof dataDir !== 'string') return
      // Plugins stay silent: a failed append only loses one index entry.
      const recorded = await recordToolEdits({ dataDir, directory: ctx.location.directory, sessionId: event.sessionID, tool: event.tool, input: event.input })
      if (recorded instanceof Error) return
    })
  },
})
