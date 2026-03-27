import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { spiceflowPlugin } from 'spiceflow/vite'

export default defineConfig({
  clearScreen: false,
  plugins: [
    spiceflowPlugin({
      entry: './app/main.tsx',
    }),
    react(),
    tailwindcss(),
  ],
})
