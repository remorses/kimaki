import { Plugin, Credential, Integration } from '@opencode/plugin'

export default Plugin.define({
  id: 'p7-auth-test',
  async setup(ctx) {
    await ctx.integration.transform((editor) => {
      editor.method.update({ integrationID: 'openai', method: { id: 'p7-code', type: 'oauth', label: 'Test OAuth code' },
        authorize: async () => ({ mode: 'code', url: 'http://127.0.0.1/authorize', instructions: 'Enter the test authorization code.',
          callback: async (code) => {
            if (code !== 'test-code') throw new Error('Invalid authorization code')
            return Credential.OAuth.make({ type: 'oauth', methodID: Integration.MethodID.make('p7-code'), access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600000 })
          },
        }),
      })
    })
  },
})
