// Drizzle Kit config for Kimaki's local SQLite schema export.

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
})
