import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { spiceflowPlugin } from 'spiceflow/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig(() => ({
  clearScreen: false,
  plugins: [
    react(),
    spiceflowPlugin({
      entry: './src/index.tsx',
    }),
    tailwindcss(),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
}))
