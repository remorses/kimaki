// v2 OpenCode plugin directory for Kimaki.
// Registers IPC tools, shell schema extras, MEMORY.md overview, and
// branch/pwd/tutorial context. OpenCode v2 loads a directory, not a .ts file.

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
import {
  ONBOARDING_TUTORIAL_INSTRUCTIONS,
  TUTORIAL_WELCOME_TEXT,
} from '../onboarding-tutorial.ts'
import { condenseMemoryMd } from '../condense-memory.ts'

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
  createPluginLogger: (prefix: string) => {
    warn: (...args: unknown[]) => void
  }
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

type GitState = {
  key: string
  kind: 'branch' | 'detached-head' | 'detached-submodule'
  label: string
  warning: string | null
}

type ContextSessionState = {
  announcedDirectory: string | undefined
  frozenMemoryOverview: string | null | undefined
}

const CONTEXT_KEY = Symbol.for('kimaki.opencode-plugin.context')

function getContextSessions() {
  const globalState = globalThis as typeof globalThis & {
    [CONTEXT_KEY]?: Map<string, ContextSessionState>
  }
  const existing = globalState[CONTEXT_KEY]
  if (existing) return existing
  const created = new Map<string, ContextSessionState>()
  globalState[CONTEXT_KEY] = created
  return created
}

function getContextSession(sessionID: string) {
  const sessions = getContextSessions()
  const existing = sessions.get(sessionID)
  if (existing) return existing
  const created: ContextSessionState = {
    announcedDirectory: undefined,
    frozenMemoryOverview: undefined,
  }
  sessions.set(sessionID, created)
  return created
}

function pushSystemText(
  event: { system: Array<{ type: string; text: string }> },
  text: string,
) {
  if (!text.trim()) return
  event.system.push({ type: 'text', text })
}

function latestUserText(messages: Array<{ role: string; content: unknown }>) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    if (!Array.isArray(message.content)) continue
    const texts = message.content.flatMap((part) => {
      if (!part || typeof part !== 'object' || !('type' in part)) return []
      if (part.type !== 'text' || !('text' in part) || typeof part.text !== 'string') {
        return []
      }
      return [part.text]
    })
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

async function resolveGitState(directory: string): Promise<GitState | null> {
  const { execAsync } = (await import(siblingModuleHref('exec-async'))) as {
    execAsync: (
      command: string,
      options?: { cwd?: string },
    ) => Promise<{ stdout: string; stderr: string }>
  }
  const branchResult = await execAsync('git symbolic-ref --short HEAD', {
    cwd: directory,
  }).catch(() => null)
  if (branchResult && !(branchResult instanceof Error)) {
    const branch = branchResult.stdout.trim()
    if (branch) {
      return {
        key: `branch:${branch}`,
        kind: 'branch',
        label: branch,
        warning: null,
      }
    }
  }
  const shaResult = await execAsync('git rev-parse --short HEAD', {
    cwd: directory,
  }).catch(() => null)
  if (!shaResult || shaResult instanceof Error) return null
  const shortSha = shaResult.stdout.trim()
  if (!shortSha) return null
  const superprojectResult = await execAsync(
    'git rev-parse --show-superproject-working-tree',
    { cwd: directory },
  ).catch(() => null)
  const superproject =
    superprojectResult && !(superprojectResult instanceof Error)
      ? superprojectResult.stdout.trim()
      : ''
  if (superproject) {
    return {
      key: `detached-submodule:${shortSha}`,
      kind: 'detached-submodule',
      label: `detached submodule @ ${shortSha}`,
      warning:
        `\n[warning: submodule is in detached HEAD at ${shortSha}. ` +
        'create or switch to a branch before committing.]',
    }
  }
  return {
    key: `detached-head:${shortSha}`,
    kind: 'detached-head',
    label: `detached HEAD @ ${shortSha}`,
    warning:
      `\n[warning: repository is in detached HEAD at ${shortSha}. ` +
      'create or switch to a branch before committing.]',
  }
}

async function readTextFile(filePath: string) {
  const result = await fs.promises.readFile(filePath, 'utf8').catch(() => null)
  if (!result || !result.trim()) return null
  return result
}

function pwdChangeText({
  currentDir,
  previousDir,
}: {
  currentDir: string
  previousDir: string
}) {
  return (
    `\n[working directory changed (cwd / pwd has changed). ` +
    `The user expects you to edit files in the new cwd. ` +
    `Previous folder (DO NOT TOUCH): ${previousDir}. ` +
    `New folder (new cwd / pwd, edit files here): ${currentDir}. ` +
    `You MUST read, write, and edit files only under the new folder ${currentDir}. ` +
    `You MUST NOT read, write, or edit any files under the previous folder ${previousDir} — ` +
    `that folder is a separate checkout and the user or another agent may be actively working there, ` +
    `so writing to it would override their unrelated changes.]\n`
  )
}

async function freezeMemoryOverview(directory: string) {
  const memoryContent = await readTextFile(path.join(directory, 'MEMORY.md'))
  if (!memoryContent) return null
  const condensed = condenseMemoryMd(memoryContent)
  return `<system-reminder>Project memory from MEMORY.md (condensed table of contents, line numbers shown):\n${condensed}\nOnly headings are shown above — section bodies are hidden. Use Grep to search MEMORY.md for specific topics, or Read with offset and limit to read a section's content. When writing to MEMORY.md, keep titles concise (under 10 words) and content brief (2-3 sentences max). Only track non-obvious learnings that prevent future mistakes and are not already documented in code comments or AGENTS.md. Do not duplicate information that is self-evident from the code.</system-reminder>\n`
}

const SHELL_INPUT = Schema.Struct({
  command: Schema.String.annotate({
    description: 'Shell command string to execute',
  }),
  description: Schema.optional(Schema.String).annotate({
    description:
      'Short 5-10 word summary shown in Discord when the command is longer than 50 characters',
  }),
  hasSideEffect: Schema.optional(Schema.Boolean).annotate({
    description:
      'True if the command writes files, modifies state, installs packages, or triggers external effects',
  }),
  workdir: Schema.optional(Schema.String).annotate({
    description:
      'Working directory to execute the command in. Defaults to the current working directory.',
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description:
      'Timeout in milliseconds. Set to 0 to disable the timeout.',
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      'Run the command in the background and return immediately.',
  }),
})

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
  id: 'kimaki',
  setup: async (ctx) => {
    await configureProcessDataDir()
    const directory = ctx.location.directory
    const pluginLogger = (await import(
      siblingModuleHref('plugin-logger')
    )) as PluginLoggerModule
    const logger = pluginLogger.createPluginLogger('PLUGIN')
    const sessions = getContextSessions()
    const eventAbort = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: eventAbort.signal,
        })) {
          if (event.type !== 'session.deleted') continue
          sessions.delete(event.data.sessionID)
        }
      } catch {
        // aborted on plugin unload
      }
    })()

    await ctx.session.hook('context', async (event) => {
      const state = getContextSession(event.sessionID)
      const userText = latestUserText(event.messages)
      if (userText.includes(TUTORIAL_WELCOME_TEXT)) {
        pushSystemText(
          event,
          `<system-reminder>\n${ONBOARDING_TUTORIAL_INSTRUCTIONS}\n</system-reminder>\n`,
        )
      }

      if (state.announcedDirectory && state.announcedDirectory !== directory) {
        pushSystemText(
          event,
          pwdChangeText({
            currentDir: directory,
            previousDir: state.announcedDirectory,
          }),
        )
      }
      state.announcedDirectory = directory

      const gitState = await resolveGitState(directory)
      if (gitState) {
        const branchText = gitState.warning || `\n[current git branch is ${gitState.label}]`
        pushSystemText(event, `${branchText}\n`)
      }

      if (state.frozenMemoryOverview === undefined) {
        const overview = await freezeMemoryOverview(directory).catch((error) => {
          logger.warn('MEMORY.md overview failed', error)
          return null
        })
        state.frozenMemoryOverview = overview
      }
      if (state.frozenMemoryOverview) {
        pushSystemText(event, state.frozenMemoryOverview)
      }
    })

    await ctx.tool.transform((tools) => {
      const shell = tools.get('shell') || tools.get('bash')
      if (shell) {
        tools.update(shell.id, (tool) => {
          tool.input = SHELL_INPUT
          const current = tool.description || ''
          if (!current.includes('hasSideEffect')) {
            tool.description =
              `${current} Pass description (short Discord summary) and hasSideEffect (true if the command writes files or has external effects).`.trim()
          }
        })
      }
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

    return () => {
      eventAbort.abort()
    }
  },
})
