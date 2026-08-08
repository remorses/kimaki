// In-process MCP server exposing kimaki's Discord tools to Claude sessions.
//
// OpenCode sessions get kimaki_file_upload / kimaki_action_buttons via the
// ipc-tools plugin running inside the opencode server process. Claude Code
// sessions run in the bot process itself, so the same tools are provided as
// an SDK MCP server writing to the identical ipc_requests table — the
// existing ipc-polling machinery picks the rows up and renders the Discord UI
// with no backend-specific code.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import dedent from 'string-dedent'
import { createIpcRequest, getIpcRequestById, getThreadIdBySessionId } from '../database.js'

const FILE_UPLOAD_TIMEOUT_MS = 6 * 60 * 1000
const DEFAULT_FILE_UPLOAD_MAX_FILES = 5
const ACTION_BUTTON_TIMEOUT_MS = 30 * 1000

async function pollIpcResponse({
  id,
  timeoutMs,
  pollIntervalMs,
  cancelledMessage,
  timeoutMessage,
  parse,
}: {
  id: string
  timeoutMs: number
  pollIntervalMs: number
  cancelledMessage: string
  timeoutMessage: string
  parse: (response: string) => string
}): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs)
    })
    const updated = await getIpcRequestById({ id })
    if (!updated || updated.status === 'cancelled') {
      return cancelledMessage
    }
    if (updated.response) {
      return parse(updated.response)
    }
  }
  return timeoutMessage
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * Build the kimaki MCP server for one Claude session. The wire session id is
 * the shim session id (ses_claude_...), which thread_sessions maps back to a
 * Discord thread — same lookup the opencode plugin does.
 */
export function createKimakiMcpServer({
  sessionId,
  directory,
}: {
  sessionId: string
  directory: string
}) {
  return createSdkMcpServer({
    name: 'kimaki',
    version: '1.0.0',
    tools: [
      tool(
        'kimaki_file_upload',
        'Prompt the Discord user to upload files using a native file picker modal. ' +
          'The user sees a button, clicks it, and gets a file upload dialog. ' +
          'Returns the local file paths of downloaded files in the project directory. ' +
          'Use this when you need the user to provide files (images, documents, configs, etc.). ' +
          'IMPORTANT: Always call this tool last in your message, after all text parts.',
        {
          prompt: z.string().describe('Message shown to the user explaining what files to upload'),
          maxFiles: z
            .number()
            .min(1)
            .max(10)
            .optional()
            .describe('Maximum number of files the user can upload (1-10, default 5)'),
        },
        async ({ prompt, maxFiles }) => {
          const threadId = await getThreadIdBySessionId(sessionId)
          if (!threadId) {
            return textResult('Could not find thread for current session')
          }
          const ipcRow = await createIpcRequest({
            type: 'file_upload',
            sessionId,
            threadId,
            payload: JSON.stringify({
              prompt,
              maxFiles: maxFiles || DEFAULT_FILE_UPLOAD_MAX_FILES,
              directory,
            }),
          })
          const result = await pollIpcResponse({
            id: ipcRow.id,
            timeoutMs: FILE_UPLOAD_TIMEOUT_MS,
            pollIntervalMs: 300,
            cancelledMessage: 'File upload was cancelled',
            timeoutMessage:
              'File upload timed out - user did not upload files within the time limit',
            parse: (response) => {
              const parsed = JSON.parse(response) as {
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
            },
          })
          return textResult(result)
        },
      ),
      tool(
        'kimaki_action_buttons',
        dedent`
          Show action buttons in the current Discord thread for quick confirmations.
          Use this when the user can respond by clicking one of up to 3 buttons.
          Prefer a single button whenever possible.
          Default color is white (same visual style as permission deny button).
          If you need more than 3 options, use the AskUserQuestion tool instead.
          IMPORTANT: Always call this tool last in your message, after all text parts.

          Examples:
          - buttons: [{"label":"Yes, proceed"}]
          - buttons: [{"label":"Approve","color":"green"}]
          - buttons: [
              {"label":"Confirm","color":"blue"},
              {"label":"Cancel","color":"white"}
            ]
        `,
        {
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
        async ({ buttons }) => {
          const threadId = await getThreadIdBySessionId(sessionId)
          if (!threadId) {
            return textResult('Could not find thread for current session')
          }
          const ipcRow = await createIpcRequest({
            type: 'action_buttons',
            sessionId,
            threadId,
            payload: JSON.stringify({ buttons, directory }),
          })
          const result = await pollIpcResponse({
            id: ipcRow.id,
            timeoutMs: ACTION_BUTTON_TIMEOUT_MS,
            pollIntervalMs: 200,
            cancelledMessage: 'Action button request was cancelled',
            timeoutMessage: 'Action button request timed out',
            parse: (response) => {
              const parsed = JSON.parse(response) as {
                ok?: boolean
                error?: string
              }
              if (parsed.error) {
                return `Action button request failed: ${parsed.error}`
              }
              return `Action button(s) shown: ${buttons
                .map((button) => {
                  return button.label
                })
                .join(', ')}`
            },
          })
          return textResult(result)
        },
      ),
    ],
  })
}
