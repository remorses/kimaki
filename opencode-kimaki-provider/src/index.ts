// Kimaki Pro provider plugin for OpenCode.
// Registers the Kimaki provider in /connect and augments its model list.
//
// Users install this package globally and add it to their opencode.json:
//   "plugin": ["@kimaki/opencode-kimaki-provider"]
//
// They also need the provider config snippet (see README).
// For Kimaki Discord bot users, both are injected automatically.

const KIMAKI_API_URL = 'https://openai.kimaki.dev/v1'

import type { Hooks, PluginInput } from '@opencode-ai/plugin'

export default async function kimakiProPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: 'kimaki',
      methods: [
        {
          type: 'api' as const,
          label: 'Kimaki Pro API Key',
          prompts: [
            {
              type: 'text' as const,
              key: 'apiKey',
              message:
                'Enter your Kimaki Pro API key (get one at kimaki.dev/dashboard)',
            },
          ],
          authorize: async (inputs) => {
            const apiKey = inputs?.apiKey
            if (!apiKey || typeof apiKey !== 'string') {
              return { type: 'failed' as const }
            }

            // Validate the key by calling the models endpoint
            try {
              const res = await fetch(`${KIMAKI_API_URL}/models`, {
                headers: { Authorization: `Bearer ${apiKey}` },
              })
              if (!res.ok) {
                return { type: 'failed' as const }
              }
              return { type: 'success' as const, key: apiKey }
            } catch {
              return { type: 'failed' as const }
            }
          },
        },
      ],
    },
  }
}
