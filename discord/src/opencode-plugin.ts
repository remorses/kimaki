// OpenCode plugin that provides a messagediff tool for generating critique URLs
// showing file changes for a session or specific message.

import { spawn } from 'node:child_process'
import { createTwoFilesPatch } from 'diff'
import { tool } from '@opencode-ai/plugin/tool'
import type { Plugin } from '@opencode-ai/plugin'

const kimakiPlugin: Plugin = async ({ client, directory }) => {
  return {
    tool: {
      messagediff: tool({
        description:
          'Get a shareable critique URL showing the diff of file changes. Use this tool to return the diff URL to the user so they can review the changes. Pass index=-1 when you made incremental updates so the user only sees the latest changes instead of the full session diff. Omit index to show all changes made during the entire session.',
        args: {
          index: tool.schema
            .number()
            .optional()
            .describe(
              'Message index. -1 = last message (use for incremental updates), 0 = first message. Omit for full session diff.',
            ),
        },
        async execute(args, ctx) {
          // Get messages to find the messageID if index provided
          let messageID: string | undefined

          if (args.index !== undefined) {
            const { data: messages } = await client.session.messages({
              path: { id: ctx.sessionID },
              query: { directory },
            })

            if (!messages || messages.length === 0) {
              return 'No messages in session'
            }

            // Filter to user messages only (they trigger the file changes)
            const userMessages = messages.filter((m) => {
              return m.info.role === 'user'
            })

            if (userMessages.length === 0) {
              return 'No user messages found'
            }

            const idx =
              args.index < 0 ? userMessages.length + args.index : args.index

            const targetMessage = userMessages[idx]
            if (idx < 0 || idx >= userMessages.length || !targetMessage) {
              return `Invalid index. Valid range: 0 to ${userMessages.length - 1} (or -1 for last)`
            }

            messageID = targetMessage.info.id
          }

          // Get the diff from opencode
          const { data: diffs } = await client.session.diff({
            path: { id: ctx.sessionID },
            query: { directory, messageID },
          })

          if (!diffs || diffs.length === 0) {
            return 'No file changes found'
          }

          // Generate unified patch from before/after content
          const patches = diffs.map((d) => {
            return createTwoFilesPatch(
              `a/${d.file}`,
              `b/${d.file}`,
              d.before,
              d.after,
            )
          })
          const combinedPatch = patches.join('')

          const description =
            args.index !== undefined
              ? `Message ${args.index} changes`
              : 'Session changes'

          // Run critique with stdin
          return new Promise((resolve) => {
            const proc = spawn(
              'bunx',
              ['critique', '--stdin', '--web', description],
              {
                cwd: directory,
                stdio: ['pipe', 'pipe', 'pipe'],
              },
            )

            let stdout = ''
            let stderr = ''

            proc.stdout.on('data', (data: Buffer) => {
              stdout += data.toString()
            })
            proc.stderr.on('data', (data: Buffer) => {
              stderr += data.toString()
            })

            proc.on('close', () => {
              const output = stdout + stderr
              const urlMatch = output.match(/https?:\/\/[^\s]+/)
              if (urlMatch) {
                resolve(urlMatch[0])
              } else {
                resolve(output.trim() || 'Critique completed but no URL found')
              }
            })

            proc.on('error', (err) => {
              resolve(`Failed to run critique: ${err.message}`)
            })

            proc.stdin.write(combinedPatch)
            proc.stdin.end()
          })
        },
      }),
    },
  }
}

export { kimakiPlugin }
