// Kimaki Pro provider auth plugin for OpenCode.
// Registers the Kimaki provider in /connect so users can paste their API key
// and have it stored in ~/.local/share/opencode/auth.json.
// This is the bundled version that ships with the Kimaki Discord bot.
// The standalone version lives in opencode-kimaki-provider/.

import type { Hooks, PluginInput } from '@opencode-ai/plugin'

const KIMAKI_API_URL = 'https://openai.kimaki.dev/v1'

export async function kimakiProPlugin(_input: PluginInput): Promise<Hooks> {
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
