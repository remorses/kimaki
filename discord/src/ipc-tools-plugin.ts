// OpenCode plugin that provides IPC-based tools for Discord interaction:
// - kimaki_file_upload: prompts the Discord user to upload files via native picker
// - kimaki_action_buttons: shows clickable action buttons in the Discord thread
//
// Tools communicate with the bot process via IPC rows in SQLite (the plugin
// runs inside the OpenCode server process, not the bot process).
//
// Exported from kimaki-opencode-plugin.ts — each export is treated as a separate
// plugin by OpenCode's plugin loader.

import type { Plugin } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import dedent from 'string-dedent'
import { z } from 'zod'
import { setDataDir } from './config.js'
import { createLogger, LogPrefix, setLogFilePath } from './logger.js'
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
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string>
}) {
  return input
}

const logger = createLogger(LogPrefix.OPENCODE)

const FILE_UPLOAD_TIMEOUT_MS = 6 * 60 * 1000
const DEFAULT_FILE_UPLOAD_MAX_FILES = 5
const ACTION_BUTTON_TIMEOUT_MS = 30 * 1000

async function loadDatabaseModule() {
  // The plugin-loading e2e test boots OpenCode directly without the bot-side
  // Hrana env vars. Lazy-loading avoids pulling Prisma + libsql sqlite mode
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
    setLogFilePath(dataDir)
  }

  return {
    tool: {
      kimaki_file_upload: tool({
        description:
          'Prompt the Discord user to upload files using a native file picker modal. ' +
          'The user sees a button, clicks it, and gets a file upload dialog. ' +
          'Returns the local file paths of downloaded files in the project directory. ' +
          'Use this when you need the user to provide files (images, documents, configs, etc.). ' +
          'IMPORTANT: Always call this tool last in your message, after all text parts.',
        args: {
          prompt: z.string().describe('Message shown to the user explaining what files to upload'),
          maxFiles: z
            .number()
            .min(1)
            .max(10)
            .optional()
            .describe('Maximum number of files the user can upload (1-10, default 5)'),
        },
        async execute({ prompt, maxFiles }, context) {
          const { getPrisma, createIpcRequest, getIpcRequestById } = await loadDatabaseModule()
          const prisma = await getPrisma()
          const row = await prisma.thread_sessions.findFirst({
            where: { session_id: context.sessionID },
            select: { thread_id: true },
          })

          if (!row?.thread_id) {
            return 'Could not find thread for current session'
          }

          const ipcRow = await createIpcRequest({
            type: 'file_upload',
            sessionId: context.sessionID,
            threadId: row.thread_id,
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
          If you need more than 3 options, use the question tool instead.
          IMPORTANT: Always call this tool last in your message, after all text parts.

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
            .describe('Array of 1-3 action buttons. Prefer one button whenever possible.'),
        },
        async execute({ buttons }, context) {
          const { getPrisma, createIpcRequest, getIpcRequestById } = await loadDatabaseModule()
          const prisma = await getPrisma()
          const row = await prisma.thread_sessions.findFirst({
            where: { session_id: context.sessionID },
            select: { thread_id: true },
          })

          if (!row?.thread_id) {
            return 'Could not find thread for current session'
          }

          const ipcRow = await createIpcRequest({
            type: 'action_buttons',
            sessionId: context.sessionID,
            threadId: row.thread_id,
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
    },
  }
}

export { ipcToolsPlugin }
