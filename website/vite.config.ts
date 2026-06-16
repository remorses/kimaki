import { holocron } from '@holocron.so/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    holocron({ entry: './src/server.tsx', pagesDir: './src/docs' }),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
  resolve: {
    dedupe: ['spiceflow', 'spiceflow/react', 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },

})
