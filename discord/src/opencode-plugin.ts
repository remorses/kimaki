/**
 * Kimaki Discord Plugin for OpenCode
 *
 * Adds /send-to-kimaki-discord command that sends the current session to Discord.
 *
 * Installation:
 *   kimaki install-plugin
 *
 * Use in OpenCode TUI:
 *   /send-to-kimaki-discord
 */

import type { Plugin } from '@opencode-ai/plugin'

export const KimakiDiscordPlugin: Plugin = async ({
  client,
  $,
  directory,
}) => {
  return {
    event: async ({ event }) => {
      if (event.type !== 'command.executed') {
        return
      }

      const { name, sessionID } = event.properties as {
        name: string
        sessionID: string
      }

      if (name !== 'send-to-kimaki-discord') {
        return
      }

      if (!sessionID) {
        await client.tui.showToast({
          body: { message: 'No session ID available', variant: 'error' },
        })
        return
      }

      await client.tui.showToast({
        body: { message: 'Creating Discord thread...', variant: 'info' },
      })

      try {
        const result =
          await $`npx -y kimaki send-to-discord ${sessionID} -d ${directory}`.text()

        const urlMatch = result.match(/https:\/\/discord\.com\/channels\/\S+/)
        const url = urlMatch ? urlMatch[0] : null

        await client.tui.showToast({
          body: {
            message: url ? `Sent to Discord: ${url}` : 'Session sent to Discord',
            variant: 'success',
          },
        })
      } catch (error: any) {
        const message =
          error.stderr?.toString().trim() ||
          error.stdout?.toString().trim() ||
          error.message ||
          String(error)

        await client.tui.showToast({
          body: {
            message: `Failed: ${message.slice(0, 100)}`,
            variant: 'error',
          },
        })
      }
    },
  }
}
