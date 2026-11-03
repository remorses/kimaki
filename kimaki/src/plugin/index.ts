import { Plugin, Skill } from '@opencode/plugin'
import type { SessionContext } from '@opencode/plugin/promise/session'
import { Schema } from 'effect'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

import { autostartBot } from '../autostart.ts'
import { readBuiltinSkills } from '../builtin-skills.ts'
import { fileEditTool, recordToolEdits } from '../file-edit-log.ts'
import { registerCoordinatorRoles, registerWarmup } from './coordinator.ts'
import { turnContext } from '../system-prompt.ts'

const exec = promisify(execFile)

const decodeSkill = Schema.decodeUnknownSync(Skill.Info)

const BRANCH_PREFIX = '[current git branch is '
// Prompt metadata key: ms between the latest assistant message and the prompt.
const GAP_KEY = 'sinceAssistantMs'

// `3d 4h`, `2h 5m`, `12m 5s`, `40s`: enough to tell a quick follow-up from a return after a break.
function formatGap(ms: number): string {
  const seconds = Math.floor(ms / 1_000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

export default Plugin.define({
  id: 'kimaki',
  async setup(ctx) {
    autostartBot()
    // Skills are per location, not per session, so OpenCode lists them in every
    // session, TUI included. Descriptions say they are for Kimaki sessions only;
    // the bot denies disabled ones per session (--disable-skills). A failed read
    // only loses the skills.
    const skills = await readBuiltinSkills()
    if (!(skills instanceof Error)) {
      await ctx.skill.transform((editor) => {
        for (const skill of skills) {
          editor.add(decodeSkill(skill))
        }
      })
    }
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
    // The prompt hook runs before OpenCode admits the prompt, so changes to its
    // metadata are stored with it and a synthetic message saved here comes first.
    await ctx.session.hook('prompt', async (event) => {
      if (!(await marker(event.sessionID))) return
      const [history, branch] = await Promise.all([
        ctx.session.context({ sessionID: event.sessionID }).catch(() => null),
        exec('git', ['branch', '--show-current'], { cwd: ctx.location.directory, timeout: 5000 }).catch(() => null),
      ])
      if (!history) return
      // The time since the latest reply is stored on the prompt and rendered by
      // shapeRequest: a value computed per request would change the cached prefix.
      const reply = history.findLast((message) => message.type === 'assistant')
      if (reply?.type === 'assistant') event.metadata = { ...event.metadata, [GAP_KEY]: Math.max(0, Date.now() - (reply.time.completed ?? reply.time.created)) }
      // The git branch is a synthetic message, only when it changed. Text in
      // event.system would change the cached prompt prefix on every branch switch.
      const name = branch?.stdout.trim()
      if (!name) return
      const text = `${BRANCH_PREFIX}${name}]`
      const last = history.findLast((message) => message.type === 'synthetic' && message.text.startsWith(BRANCH_PREFIX))
      if (last?.type === 'synthetic' && last.text === text) return
      await ctx.session.synthetic({ sessionID: event.sessionID, text, delivery: event.delivery, resume: false }).catch(() => undefined)
    })
    // Runs for every request kind: turns (context), compaction and generate (OpenCode
    // `warming` keep-alive requests). All kinds must get the same system text, tools
    // and messages, or the provider prompt cache misses.
    const shapeRequest = async (event: SessionContext) => {
      // The only prompt change for every session, TUI included. The ID never
      // changes in a session, so the cached prompt prefix stays stable.
      event.system.push({ type: 'text', text: `OpenCode session ID: ${event.sessionID}` })
      if (!(await marker(event.sessionID))) return
      // The time since the previous reply and the <discord-user> context of each
      // prompt, built from its metadata, so the stored text stays clean for the TUI
      // and other clients. Same metadata, same text on every request: the cached
      // prompt prefix stays stable.
      for (const message of event.messages) {
        if (message.role !== 'user') continue
        const gap = message.metadata?.[GAP_KEY]
        for (const text of [typeof gap === 'number' ? `[${formatGap(gap)} since your last message]` : null, turnContext(message.metadata)]) {
          // TODO: build a new Message once plugins can import OpenCode's Message class;
          // a copy from another module instance may fail its instanceof checks.
          if (text) Array.prototype.push.call(message.content, { type: 'text', text })
        }
      }
      // Extra inputs only for the Discord tool line. OpenCode decodes the real
      // inputs with Schema.Struct, which ignores unknown keys.
      const description = { type: 'string', description: 'Short 5-10 word summary shown in Discord' }
      const extras = {
        shell: { description, hasSideEffect: { type: 'boolean', description: 'True if Discord should show this command so the user is aware it runs. False hides it' } },
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
    }
    await ctx.session.hook('context', shapeRequest)
    await ctx.session.hook('compaction', shapeRequest)
    await ctx.session.hook('generate', shapeRequest)
    // On Windows the shell is often PowerShell or cmd.exe, which cannot run the POSIX
    // prefix, and Git Bash splits a `C:\...` PATH entry on `:`. There shell create.before
    // swaps the prefix for env vars, which every shell inherits (MSYS converts the
    // Windows PATH itself). That hook has no session or tool call, so the prefixed
    // command, unique per tool call, is the key.
    const windowsShells = new Map<string, { command: string; bin: string; env: Record<string, string> }>()
    await ctx.tool.hook('execute.before', async (event) => {
      if (event.tool !== 'shell' || !event.input || typeof event.input !== 'object' || Array.isArray(event.input)) return
      const info = await marker(event.sessionID)
      const dataDir = info?.get('dataDir')
      const lockPort = info?.get('lockPort')
      if (typeof dataDir !== 'string' || typeof lockPort !== 'number') return
      if (!('command' in event.input) || typeof event.input.command !== 'string') return
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      const bin = path.join(dataDir, 'bin')
      const env = { KIMAKI_DATA_DIR: dataDir, KIMAKI_LOCK_PORT: String(lockPort), KIMAKI_TOOL_CALL: `${event.messageID}:${event.id}` }
      const command = event.input.command
      const prefixed = `export PATH=${quote(bin)}:"$PATH" ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(' ')}; ${command}`
      event.input.command = prefixed
      if (process.platform === 'win32') windowsShells.set(prefixed, { command, bin, env })
    })
    if (process.platform === 'win32') {
      await ctx.shell.hook('create.before', (event) => {
        const pending = windowsShells.get(event.command)
        if (!pending) return
        windowsShells.delete(event.command)
        event.command = pending.command
        // Spread from process.env, so the key keeps its Windows case (usually `Path`).
        const keys = Object.keys(event.env).filter((key) => key.toUpperCase() === 'PATH')
        for (const key of keys.length > 0 ? keys : ['Path']) {
          event.env[key] = [pending.bin, event.env[key]].filter(Boolean).join(path.delimiter)
        }
        Object.assign(event.env, pending.env)
      })
    }
    await registerCoordinatorRoles(ctx)
    const stopWarmup = await registerWarmup(ctx)
    // File edits feed `kimaki session editors` (v1-compatible JSONL index).
    await ctx.tool.hook('execute.after', async (event) => {
      if (event.status !== 'completed' || !fileEditTool(event.tool)) return
      const dataDir = (await marker(event.sessionID))?.get('dataDir')
      if (typeof dataDir !== 'string') return
      // Plugins stay silent: a failed append only loses one index entry.
      const recorded = await recordToolEdits({ dataDir, directory: ctx.location.directory, sessionId: event.sessionID, tool: event.tool, input: event.input })
      if (recorded instanceof Error) return
    })
    return stopWarmup
  },
})
