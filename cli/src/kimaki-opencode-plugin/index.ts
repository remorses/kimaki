// v2 OpenCode plugin directory for Kimaki IPC tools.
// OpenCode v2 loads plugins from a directory, not a .ts file. This plugin
// registers kimaki_file_upload, kimaki_action_buttons, and kimaki_sleep.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Schema } from 'effect'
import { Plugin } from '@opencode/plugin'
import dedent from 'string-dedent'
import type {
  createIpcRequest,
  getIpcRequestById,
  getThreadIdBySessionId,
  upsertSessionSleep,
} from '../database.ts'
import type { setDataDir } from '../config.ts'
import type { setPluginLogFilePath } from '../plugin-logger.ts'
import type {
  formatSessionSleepToolOutput,
  formatSessionSleepWakeAt,
  parseSleepWakeAt,
} from '../task-schedule.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

const FILE_UPLOAD_TIMEOUT_MS = 6 * 60 * 1000
const DEFAULT_FILE_UPLOAD_MAX_FILES = 5
const ACTION_BUTTON_TIMEOUT_MS = 30 * 1000

const PROCESS_KEY = Symbol.for('kimaki.opencode-plugin.process')
const DATABASE_KEY = Symbol.for('kimaki.opencode-plugin.database')

type ProcessState = {
  dataDirConfigured: boolean
}

type DatabaseModule = {
  getThreadIdBySessionId: typeof getThreadIdBySessionId
  createIpcRequest: typeof createIpcRequest
  getIpcRequestById: typeof getIpcRequestById
  upsertSessionSleep: typeof upsertSessionSleep
}

type TaskScheduleModule = {
  parseSleepWakeAt: typeof parseSleepWakeAt
  formatSessionSleepWakeAt: typeof formatSessionSleepWakeAt
  formatSessionSleepToolOutput: typeof formatSessionSleepToolOutput
}

type ConfigModule = {
  setDataDir: typeof setDataDir
}

type PluginLoggerModule = {
  setPluginLogFilePath: typeof setPluginLogFilePath
}

function getProcessState(): ProcessState {
  const globalState = globalThis as typeof globalThis & {
    [PROCESS_KEY]?: ProcessState
  }
  const existing = globalState[PROCESS_KEY]
  if (existing) return existing
  const created: ProcessState = { dataDirConfigured: false }
  globalState[PROCESS_KEY] = created
  return created
}

function siblingModuleHref(name: string) {
  const tsPath = path.join(here, `../${name}.ts`)
  const jsPath = path.join(here, `../${name}.js`)
  return pathToFileURL(fs.existsSync(tsPath) ? tsPath : jsPath).href
}

function loadDatabaseModule() {
  const globalState = globalThis as typeof globalThis & {
    [DATABASE_KEY]?: Promise<DatabaseModule>
  }
  const existing = globalState[DATABASE_KEY]
  if (existing) return existing
  const loaded = import(siblingModuleHref('database')) as Promise<DatabaseModule>
  globalState[DATABASE_KEY] = loaded
  return loaded
}

function toolText(text: string) {
  return { output: { text }, content: text }
}

async function configureProcessDataDir() {
  const processState = getProcessState()
  if (processState.dataDirConfigured) return
  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    const config = (await import(siblingModuleHref('config'))) as ConfigModule
    config.setDataDir(dataDir)
    const pluginLogger = (await import(
      siblingModuleHref('plugin-logger')
    )) as PluginLoggerModule
    pluginLogger.setPluginLogFilePath(dataDir)
  }
  processState.dataDirConfigured = true
}

export default Plugin.define({
  id: 'kimaki.ipc-tools',
  setup: async (ctx) => {
    await configureProcessDataDir()
    const directory = ctx.location.directory

    await ctx.session.hook('context', (event) => {
      const dataDir = process.env.KIMAKI_DATA_DIR
      if (!dataDir) return
      const filePath = path.join(dataDir, 'session-system', `${event.sessionID}.txt`)
      if (!fs.existsSync(filePath)) return
      const persisted = fs.readFileSync(filePath, 'utf8')
      if (!persisted.trim()) return
      const alreadyInjected = event.system.some((part) => {
        return part.type === 'text' && part.text.includes('via kimaki.dev')
      })
      if (alreadyInjected) return
      event.system.push({ type: 'text', text: persisted })
    })

    await ctx.tool.transform((tools) => {
      tools.add({
        name: 'kimaki_file_upload',
        options: { codemode: false },
        description:
          'Prompt the Discord user to upload files using a native file picker modal. ' +
          'The user sees a button, clicks it, and gets a file upload dialog. ' +
          'Returns the local file paths of downloaded files in the project directory. ' +
          'Use this when you need the user to provide files (images, documents, configs, etc.). ' +
          'You MUST call kimaki_file_upload LAST, after ALL text. NEVER call it before your text.',
        input: Schema.Struct({
          prompt: Schema.String,
          maxFiles: Schema.optional(Schema.Number),
        }),
        output: Schema.Struct({ text: Schema.String }),
        execute: async ({ prompt, maxFiles }, context) => {
          const database = await loadDatabaseModule()
          const threadId = await database.getThreadIdBySessionId(
            context.sessionID,
          )
          if (!threadId) {
            return toolText('Could not find thread for current session')
          }
          const ipcRow = await database.createIpcRequest({
            type: 'file_upload',
            sessionId: context.sessionID,
            threadId,
            payload: JSON.stringify({
              prompt,
              maxFiles: maxFiles || DEFAULT_FILE_UPLOAD_MAX_FILES,
              directory,
            }),
          })
          const deadline = Date.now() + FILE_UPLOAD_TIMEOUT_MS
          while (Date.now() < deadline) {
            await new Promise((resolve) => {
              setTimeout(resolve, 300)
            })
            const updated = await database.getIpcRequestById({ id: ipcRow.id })
            if (!updated || updated.status === 'cancelled') {
              return toolText('File upload was cancelled')
            }
            if (updated.response) {
              const parsed = JSON.parse(updated.response) as {
                filePaths?: string[]
                error?: string
              }
              if (parsed.error) {
                return toolText(`File upload failed: ${parsed.error}`)
              }
              const filePaths = parsed.filePaths || []
              if (filePaths.length === 0) {
                return toolText(
                  'No files were uploaded (user may have cancelled or sent a new message)',
                )
              }
              return toolText(
                `Files uploaded successfully:\n${filePaths.join('\n')}`,
              )
            }
          }
          return toolText(
            'File upload timed out - user did not upload files within the time limit',
          )
        },
      })

      tools.add({
        name: 'kimaki_action_buttons',
        options: { codemode: false },
        description: dedent`
          Show action buttons in the current Discord thread for quick confirmations.
          Use this when the user can respond by clicking one of up to 3 buttons.
          Prefer a single button whenever possible.
          Default color is white (same visual style as permission deny button).
          If you need more than 3 options, use \`question\` instead.
          You MUST call kimaki_action_buttons LAST, after ALL text.
          NEVER call kimaki_action_buttons before your text.

          Examples:
          - buttons: [{"label":"Yes, proceed"}]
          - buttons: [{"label":"Approve","color":"green"}]
          - buttons: [
              {"label":"Confirm","color":"blue"},
              {"label":"Cancel","color":"white"}
            ]
        `,
        input: Schema.Struct({
          buttons: Schema.Array(
            Schema.Struct({
              label: Schema.String,
              color: Schema.optional(Schema.String),
            }),
          ),
        }),
        output: Schema.Struct({ text: Schema.String }),
        execute: async ({ buttons }, context) => {
          const database = await loadDatabaseModule()
          const threadId = await database.getThreadIdBySessionId(
            context.sessionID,
          )
          if (!threadId) {
            return toolText('Could not find thread for current session')
          }
          const ipcRow = await database.createIpcRequest({
            type: 'action_buttons',
            sessionId: context.sessionID,
            threadId,
            payload: JSON.stringify({
              buttons,
              directory,
            }),
          })
          const deadline = Date.now() + ACTION_BUTTON_TIMEOUT_MS
          while (Date.now() < deadline) {
            await new Promise((resolve) => {
              setTimeout(resolve, 200)
            })
            const updated = await database.getIpcRequestById({ id: ipcRow.id })
            if (!updated || updated.status === 'cancelled') {
              return toolText('Action button request was cancelled')
            }
            if (updated.response) {
              const parsed = JSON.parse(updated.response) as {
                ok?: boolean
                error?: string
              }
              if (parsed.error) {
                return toolText(`Action button request failed: ${parsed.error}`)
              }
              return toolText(
                `Action button(s) shown: ${buttons.map((button) => button.label).join(', ')}`,
              )
            }
          }
          return toolText('Action button request timed out')
        },
      })

      tools.add({
        name: 'kimaki_sleep',
        options: { codemode: false },
        description: dedent`
          Sleep this session until a future time. Kimaki later posts a wake
          message in this thread and the same session continues.
          Use this to wait hours or days for CI, a deploy, a date, or any later event.
          The sleep is stored in SQLite and survives bot restarts.

          Pass either duration (2h, 30m, 1d) or until (UTC ISO ending with Z).
          Do not pass both. You MUST call kimaki_sleep LAST, after ALL text.
          Do not call more tools after it.

          The tool result is not a wake. After it succeeds, write one short
          waiting line and stop. Do not continue the waited work until a later
          Discord message that starts with "Woke after sleeping until".
          A new user message cancels the sleep. If you still need that later
          wake after answering, call kimaki_sleep again with until set to the
          original UTC time.
        `,
        input: Schema.Struct({
          duration: Schema.optional(Schema.String),
          until: Schema.optional(Schema.String),
          reason: Schema.optional(Schema.String),
        }),
        output: Schema.Struct({ text: Schema.String }),
        execute: async ({ duration, until, reason }, context) => {
          const run = async () => {
            const schedule = (await import(
              siblingModuleHref('task-schedule')
            )) as TaskScheduleModule
            const wakeAt = schedule.parseSleepWakeAt({
              duration,
              until,
              now: new Date(),
            })
            if (wakeAt instanceof Error) {
              return toolText(wakeAt.message)
            }
            const database = await loadDatabaseModule()
            const threadId = await database.getThreadIdBySessionId(
              context.sessionID,
            )
            if (!threadId) {
              return toolText('sleep is only available in the main session')
            }
            await database.upsertSessionSleep({
              sessionId: context.sessionID,
              wakeAt,
              reason,
            })
            const output = schedule.formatSessionSleepToolOutput({
              wakeAt,
              reason,
            })
            return {
              output: { text: output },
              content: output,
              metadata: {
                title: `until ${schedule.formatSessionSleepWakeAt(wakeAt)}`,
              },
            }
          }
          const result = await run().catch((error: unknown) => {
            const text = error instanceof Error ? error.message : String(error)
            return toolText(text)
          })
          return result
        },
      })
    })
  },
})
