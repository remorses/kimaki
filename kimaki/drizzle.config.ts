// Drizzle Kit config, only used to export src/schema.sql from src/schema.ts.

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
})
