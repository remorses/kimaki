// OpenCode plugin that provides Discord and session tools:
// - kimaki_file_upload: prompts the Discord user to upload files via native picker
// - kimaki_action_buttons: shows clickable action buttons in the Discord thread
// - kimaki_sleep: persist a wake time so the session can sleep hours or days
//
// IPC tools talk to the bot process via SQLite rows. Sleep writes session_sleeps
// directly. The plugin runs inside the OpenCode server process, not the bot.
//
// Exported from kimaki-opencode-plugin.ts — each export is treated as a separate
// plugin by OpenCode's plugin loader.

import type { Plugin } from '@opencode-ai/plugin'
import type { ToolContext, ToolResult } from '@opencode-ai/plugin/tool'
import dedent from 'string-dedent'
import { z } from 'zod'
import { setDataDir } from './config.js'
import { createPluginLogger, setPluginLogFilePath } from './plugin-logger.js'
import { initSentry } from './sentry.js'

// Inlined from '@opencode-ai/plugin/tool' because the subpath value import
// fails at runtime in global npm installs (#35). Opencode loads this plugin
// file in its own process and resolves modules from kimaki's install dir,
// but the '/tool' subpath export isn't found by opencode's module resolver.
// The type-only imports above are fine (erased at compile time).
//
// NOTE: @opencode-ai/plugin bundles its own zod 4.1.x as a hard dependency
// while goke (used by cli.ts) requires zod 4.3.x. This version skew makes
// the Plugin return type structurally incompatible with our local tool()
// even though runtime behavior is identical. ipcToolsPlugin is cast to
// Plugin via unknown to bypass this purely type-level incompatibility.
function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: ToolContext,
  ): Promise<ToolResult>
}) {
  return input
}

const logger = createPluginLogger('OPENCODE')

const FILE_UPLOAD_TIMEOUT_MS = 6 * 60 * 1000
const DEFAULT_FILE_UPLOAD_MAX_FILES = 5
const ACTION_BUTTON_TIMEOUT_MS = 30 * 1000

async function loadDatabaseModule() {
  // The plugin-loading e2e test boots OpenCode directly without the bot-side
  // Hrana env vars. Lazy-loading avoids opening libSQL sqlite mode
  // during plugin startup when no IPC tool is being executed yet.
  return import('./database.js')
}

// @opencode-ai/plugin bundles zod 4.1.x as a hard dep; our code uses 4.3.x
// (required by goke for ~standard.jsonSchema). The Plugin return type is
// structurally incompatible due to _zod.version.minor skew even though
// runtime behavior is identical. `any` bypasses the type-level mismatch —
// opencode's plugin loader doesn't care about the zod version at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ipcToolsPlugin: any = async () => {
  initSentry()

    const dataDir = process.env.KIMAKI_DATA_DIR
    if (dataDir) {
      setDataDir(dataDir)
      setPluginLogFilePath(dataDir)
    }

  return {
    tool: {
      kimaki_file_upload: tool({
        description:
          'Prompt the Discord user to upload files using a native file picker modal. ' +
          'The user sees a button, clicks it, and gets a file upload dialog. ' +
          'Returns the local file paths of downloaded files in the project directory. ' +
          'Use this when you need the user to provide files (images, documents, configs, etc.). ' +
          'You MUST call kimaki_file_upload LAST, after ALL text. NEVER call it before your text.',
        args: {
          prompt: z
            .string()
            .describe(
              'Message shown to the user explaining what files to upload',
            ),
          maxFiles: z
            .number()
            .min(1)
            .max(10)
            .optional()
            .describe(
              'Maximum number of files the user can upload (1-10, default 5)',
            ),
        },
        async execute({ prompt, maxFiles }, context) {
          const { getThreadIdBySessionId, createIpcRequest, getIpcRequestById } = await loadDatabaseModule()
          const threadId = await getThreadIdBySessionId(context.sessionID)

          if (!threadId) {
            return 'Could not find thread for current session'
          }

          const ipcRow = await createIpcRequest({
            type: 'file_upload',
            sessionId: context.sessionID,
            threadId,
            payload: JSON.stringify({
              prompt,
              maxFiles: maxFiles || DEFAULT_FILE_UPLOAD_MAX_FILES,
              directory: context.directory,
            }),
          })

          const deadline = Date.now() + FILE_UPLOAD_TIMEOUT_MS
          const POLL_INTERVAL_MS = 300
          while (Date.now() < deadline) {
            await new Promise((resolve) => {
              setTimeout(resolve, POLL_INTERVAL_MS)
            })
            const updated = await getIpcRequestById({ id: ipcRow.id })
            if (!updated || updated.status === 'cancelled') {
              return 'File upload was cancelled'
            }
            if (updated.response) {
              const parsed = JSON.parse(updated.response) as {
                filePaths?: string[]
                error?: string
              }
              if (parsed.error) {
                return `File upload failed: ${parsed.error}`
              }
              const filePaths = parsed.filePaths || []
              if (filePaths.length === 0) {
                return 'No files were uploaded (user may have cancelled or sent a new message)'
              }
              return `Files uploaded successfully:\n${filePaths.join('\n')}`
            }
          }

          return 'File upload timed out - user did not upload files within the time limit'
        },
      }),
      kimaki_action_buttons: tool({
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
        args: {
          buttons: z
            .array(
              z.object({
                label: z
                  .string()
                  .min(1)
                  .max(80)
                  .describe('Button label shown to the user (1-80 chars)'),
                color: z
                  .enum(['white', 'blue', 'green', 'red'])
                  .optional()
                  .describe(
                    'Optional button color. white is default and preferred for most confirmations.',
                  ),
              }),
            )
            .min(1)
            .max(3)
            .describe(
              'Array of 1-3 action buttons. Prefer one button whenever possible.',
            ),
        },
        async execute({ buttons }, context) {
          const { getThreadIdBySessionId, createIpcRequest, getIpcRequestById } = await loadDatabaseModule()
          const threadId = await getThreadIdBySessionId(context.sessionID)

          if (!threadId) {
            return 'Could not find thread for current session'
          }

          const ipcRow = await createIpcRequest({
            type: 'action_buttons',
            sessionId: context.sessionID,
            threadId,
            payload: JSON.stringify({
              buttons,
              directory: context.directory,
            }),
          })

          const deadline = Date.now() + ACTION_BUTTON_TIMEOUT_MS
          const POLL_INTERVAL_MS = 200
          while (Date.now() < deadline) {
            await new Promise((resolve) => {
              setTimeout(resolve, POLL_INTERVAL_MS)
            })
            const updated = await getIpcRequestById({ id: ipcRow.id })
            if (!updated || updated.status === 'cancelled') {
              return 'Action button request was cancelled'
            }
            if (updated.response) {
              const parsed = JSON.parse(updated.response) as {
                ok?: boolean
                error?: string
              }
              if (parsed.error) {
                return `Action button request failed: ${parsed.error}`
              }
              return `Action button(s) shown: ${buttons.map((button) => button.label).join(', ')}`
            }
          }

          return 'Action button request timed out'
        },
      }),
      kimaki_sleep: tool({
        description: dedent`
          Sleep this session until a future time, then wake with a new message.
          Use this to wait hours or days for CI, a deploy, a date, or any later event.
          The sleep is stored in SQLite and survives bot restarts.

          Pass either duration (2h, 30m, 1d) or until (UTC ISO ending with Z).
          Do not pass both. You MUST call kimaki_sleep LAST, after ALL text.
          Do not call more tools after it. A new user message cancels the sleep.
        `,
        args: {
          duration: z
            .string()
            .optional()
            .describe(
              'Relative wait. Examples: 30s, 2h, 1d. Do not pass with until.',
            ),
          until: z
            .string()
            .optional()
            .describe(
              'UTC ISO date ending with Z. Example: 2026-08-20T09:00:00Z.',
            ),
          reason: z
            .string()
            .optional()
            .describe('Why the session is sleeping. Shown when it wakes.'),
        },
        async execute({ duration, until, reason }, context) {
          const { parseSleepWakeAt, formatSessionSleepWakeAt } = await import(
            './task-schedule.js'
          )
          const wakeAt = parseSleepWakeAt({
            duration,
            until,
            now: new Date(),
          })
          if (wakeAt instanceof Error) {
            return wakeAt.message
          }

          const { getThreadIdBySessionId, upsertSessionSleep } =
            await loadDatabaseModule()
          // Only a check that a thread owns this session: subagents have none.
          // The wake resolves the thread again at delivery time, so nothing
          // here can go stale if /resume rebinds the session later.
          const threadId = await getThreadIdBySessionId(context.sessionID)
          if (!threadId) {
            return 'sleep is only available in the main session'
          }

          await upsertSessionSleep({
            sessionId: context.sessionID,
            wakeAt,
            reason,
          })

          // The title carries the resolved absolute time so Discord shows the
          // real wake instant instead of a relative input like "2h".
          const untilLabel = formatSessionSleepWakeAt(wakeAt)
          const reasonText = reason?.trim()
            ? ` Reason: ${reason.trim()}.`
            : ''
          return {
            title: `until ${untilLabel}`,
            output: `Sleeping until ${untilLabel}.${reasonText} Stop now. You will be woken with a new message.`,
          }
        },
      }),
    },
  }
}

export { ipcToolsPlugin }
