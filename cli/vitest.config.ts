import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
    },
    resolve: {
        alias: {
            '@opencode-ai/sdk': path.resolve(
                __dirname,
                '../node_modules/.pnpm/@opencode-ai+sdk@0.6.3_typescript@5.9.2/node_modules/@opencode-ai/sdk/dist/index.js',
            ),
        },
    },
})
