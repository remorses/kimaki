// OpenCode plugin for Kimaki Discord bot.
// Provides IPC-based tools (file upload, action buttons) and injects synthetic
// message parts for branch changes and idle-time awareness.
// Discord REST tools (user listing, thread archiving) were moved to CLI
// commands (kimaki user list, kimaki session archive) so the plugin no
// longer needs a Discord bot token or REST client.
import type { Plugin } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import dedent from 'string-dedent'
import { z } from 'zod'

// Inlined from '@opencode-ai/plugin/tool' because the subpath value import
// fails at runtime in global npm installs (#35). Opencode loads this plugin
// file in its own process and resolves modules from kimaki's install dir,
// but the '/tool' subpath export isn't found by opencode's module resolver.
// The type-only imports above are fine (erased at compile time).
// The opencode docs recommend `import { tool } from '@opencode-ai/plugin'`
// (main entry) but their index.d.ts uses `export * from "./tool"` which
// doesn't re-export the tool function under nodenext resolution because
// tool is a merged function+namespace declaration.
function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: ToolContext,
  ): Promise<string>
}) {
  return input
}
import * as errore from 'errore'
import { getPrisma, createIpcRequest, getIpcRequestById } from './database.js'
import { setDataDir } from './config.js'
import {
  createLogger,
  formatErrorWithStack,
  LogPrefix,
  setLogFilePath,
} from './logger.js'
import { initSentry, notifyError } from './sentry.js'
import { execAsync } from './worktrees.js'

const logger = createLogger(LogPrefix.OPENCODE)

// condenseMemoryMd lives in condense-memory.ts — must NOT be exported from
// this file because OpenCode's plugin loader calls every exported function
// as a plugin initializer, which would crash marked's Lexer with non-string input.
import { condenseMemoryMd } from './condense-memory.js'

const FILE_UPLOAD_TIMEOUT_MS = 6 * 60 * 1000
const DEFAULT_FILE_UPLOAD_MAX_FILES = 5
const ACTION_BUTTON_TIMEOUT_MS = 30 * 1000

type GitState = {
  key: string
  kind: 'branch' | 'detached-head' | 'detached-submodule'
  label: string
  warning: string | null
}

async function resolveGitState({
  directory,
}: {
  directory: string
}): Promise<GitState | null> {
  const branchResult = await errore.tryAsync(() => {
    return execAsync('git symbolic-ref --short HEAD', { cwd: directory })
  })
  if (!(branchResult instanceof Error)) {
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

  const shaResult = await errore.tryAsync(() => {
    return execAsync('git rev-parse --short HEAD', { cwd: directory })
  })
  if (shaResult instanceof Error) {
    return null
  }

  const shortSha = shaResult.stdout.trim()
  if (!shortSha) {
    return null
  }

  const superprojectResult = await errore.tryAsync(() => {
    return execAsync('git rev-parse --show-superproject-working-tree', {
      cwd: directory,
    })
  })
  const superproject =
    superprojectResult instanceof Error ? '' : superprojectResult.stdout.trim()
  if (superproject) {
    return {
      key: `detached-submodule:${shortSha}`,
      kind: 'detached-submodule',
      label: `detached submodule @ ${shortSha}`,
      warning:
        `[Warning: Submodule is in detached HEAD at ${shortSha}. ` +
        'Create or switch to a branch before committing.]',
    }
  }

  return {
    key: `detached-head:${shortSha}`,
    kind: 'detached-head',
    label: `detached HEAD @ ${shortSha}`,
    warning:
      `[Warning: Repository is in detached HEAD at ${shortSha}. ` +
      'Create or switch to a branch before committing.]',
  }
}

const kimakiPlugin: Plugin = async ({ directory }) => {
  // Initialize Sentry in the plugin process (runs inside OpenCode server, not bot)
  initSentry()

  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) {
    setDataDir(dataDir)
    // Append to the same log file the bot process created (no truncation)
    setLogFilePath(dataDir)
  }

  // Per-session state for synthetic part injection
  const sessionGitStates = new Map<string, GitState>()
  const sessionLastMessageTime = new Map<string, number>()
  // Track whether we've already injected MEMORY.md contents for each session
  const sessionMemoryInjected = new Set<string>()

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
          const prisma = await getPrisma()
          const row = await prisma.thread_sessions.findFirst({
            where: { session_id: context.sessionID },
            select: { thread_id: true },
          })

          if (!row?.thread_id) {
            return 'Could not find thread for current session'
          }

          // Insert IPC request for the bot to pick up via polling
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

          // Poll for response from the bot process
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
            .describe(
              'Array of 1-3 action buttons. Prefer one button whenever possible.',
            ),
        },
        async execute({ buttons }, context) {
          const prisma = await getPrisma()
          const row = await prisma.thread_sessions.findFirst({
            where: { session_id: context.sessionID },
            select: { thread_id: true },
          })

          if (!row?.thread_id) {
            return 'Could not find thread for current session'
          }

          // Insert IPC request for the bot to pick up via polling
          const ipcRow = await createIpcRequest({
            type: 'action_buttons',
            sessionId: context.sessionID,
            threadId: row.thread_id,
            payload: JSON.stringify({
              buttons,
              directory: context.directory,
            }),
          })

          // Wait for bot to acknowledge (status changes from pending to processing/completed)
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

    // Inject synthetic parts for branch changes and idle-time gaps.
    // Synthetic parts are hidden from the TUI but sent to the model,
    // keeping it aware of context changes without cluttering the UI.
    'chat.message': async (input, output) => {
      const hookResult = await errore.tryAsync({
        try: async () => {
          const now = Date.now()
          const first = output.parts[0]
          if (!first) {
            return
          }

          const { sessionID } = input
          const messageID =
            typeof first === 'object' && first !== null && 'messageID' in first
              ? first.messageID
              : ''

          // -- Branch / detached HEAD detection --
          // Injects context when git state first appears or changes mid-session.
          const gitState = await resolveGitState({ directory })
          if (gitState) {
            const previousState = sessionGitStates.get(sessionID)
            if (!previousState || previousState.key !== gitState.key) {
              const info = (() => {
                if (gitState.warning) {
                  return gitState.warning
                }
                if (previousState?.kind === 'branch') {
                  return `[Branch changed: ${previousState.label} -> ${gitState.label}]`
                }
                return `[Current branch: ${gitState.label}]`
              })()

              sessionGitStates.set(sessionID, gitState)
              output.parts.push({
                id: crypto.randomUUID(),
                sessionID,
                messageID,
                type: 'text' as const,
                text: info,
                synthetic: true,
              })
            }
          }

          // -- MEMORY.md injection --
          // On the first user message in a session, read MEMORY.md from the
          // project root and inject a condensed table of contents (headings
          // with line numbers, bodies collapsed to ...). The agent can use
          // Read with offset/limit to drill into specific sections.
          if (!sessionMemoryInjected.has(sessionID)) {
            sessionMemoryInjected.add(sessionID)
            const memoryPath = path.join(directory, 'MEMORY.md')
            const memoryContent = await fs.promises
              .readFile(memoryPath, 'utf-8')
              .catch(() => null)
            if (memoryContent) {
              const condensed = condenseMemoryMd(memoryContent)
              output.parts.push({
                id: crypto.randomUUID(),
                sessionID,
                messageID,
                type: 'text' as const,
                text: `<system-reminder>Project memory from MEMORY.md (condensed table of contents, line numbers shown):\n${condensed}\nOnly headings are shown above — section bodies are hidden. Use Grep to search MEMORY.md for specific topics, or Read with offset and limit to read a section's content. When writing to MEMORY.md, make headings detailed and descriptive since they are the only thing visible in this prompt. You can update MEMORY.md to store learnings, tips, insights that will help prevent same mistakes, and context worth preserving across sessions.</system-reminder>`,
                synthetic: true,
              })
            }
          }

          // -- Time since last message --
          // If more than 10 minutes passed since the last user message in this session,
          // inject current time context so the model is aware of the gap.
          const lastTime = sessionLastMessageTime.get(sessionID)
          sessionLastMessageTime.set(sessionID, now)

          if (lastTime) {
            const elapsed = now - lastTime
            const TEN_MINUTES = 10 * 60 * 1000
            if (elapsed >= TEN_MINUTES) {
              const totalMinutes = Math.floor(elapsed / 60_000)
              const hours = Math.floor(totalMinutes / 60)
              const minutes = totalMinutes % 60
              const elapsedStr =
                hours > 0 ? `${hours}h ${minutes}m` : `${totalMinutes}m`

              const utcStr = new Date(now)
                .toISOString()
                .replace('T', ' ')
                .replace(/\.\d+Z$/, ' UTC')
              const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone
              const localStr = new Date(now).toLocaleString('en-US', {
                timeZone: localTz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })

              output.parts.push({
                id: crypto.randomUUID(),
                sessionID,
                messageID,
                type: 'text' as const,
                text: `[${elapsedStr} since last message | UTC: ${utcStr} | Local (${localTz}): ${localStr}]`,
                synthetic: true,
              })

              // -- Memory save reminder on idle gap --
              // When the user comes back after a long break, remind the model
              // to save any important context from the previous conversation.
              output.parts.push({
                id: crypto.randomUUID(),
                sessionID,
                messageID,
                type: 'text' as const,
                text: '<system-reminder>Long gap since last message. If the previous conversation had important learnings, tips, insights that will help prevent same mistakes, or context worth preserving, update MEMORY.md before starting the new task.</system-reminder>',
                synthetic: true,
              })
            }
          }
        },
        catch: (error) => {
          return new Error('chat.message hook failed', { cause: error })
        },
      })
      if (hookResult instanceof Error) {
        logger.warn(
          `[opencode-plugin chat.message] ${formatErrorWithStack(hookResult)}`,
        )
        void notifyError(hookResult, 'opencode-plugin chat.message hook failed')
      }
    },

    // Clean up per-session tracking state when sessions are deleted
    event: async ({ event }) => {
      const cleanupResult = await errore.tryAsync({
        try: async () => {
          if (event.type !== 'session.deleted') {
            return
          }

          const id = event.properties?.info?.id
          if (!id) {
            return
          }

          sessionGitStates.delete(id)
          sessionLastMessageTime.delete(id)
          sessionMemoryInjected.delete(id)
        },
        catch: (error) => {
          return new Error('event hook failed', { cause: error })
        },
      })
      if (cleanupResult instanceof Error) {
        logger.warn(
          `[opencode-plugin event] ${formatErrorWithStack(cleanupResult)}`,
        )
        void notifyError(cleanupResult, 'opencode-plugin event hook failed')
      }
    },
  }
}

export { kimakiPlugin }
export { interruptOpencodeSessionOnUserMessage } from './opencode-interrupt-plugin.js'
