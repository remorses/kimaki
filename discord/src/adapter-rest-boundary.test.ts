// Guardrail test to keep REST helpers out of adapter-consumer runtime files.
// CLI/task-runner/discord-utils must use platform adapter interfaces instead of
// direct createDiscordRest/discordRoutes/discordApiUrl imports.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const TARGET_FILES = [
  'src/cli.ts',
  'src/task-runner.ts',
  'src/discord-utils.ts',
]

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')

describe('adapter rest boundary', () => {
  test('forbids direct REST helper imports in migrated files', () => {
    const violations = TARGET_FILES.flatMap((relativePath) => {
      const filePath = path.join(PROJECT_ROOT, relativePath)
      const content = fs.readFileSync(filePath, 'utf8')
      const matches = [
        /\bcreateDiscordRest\b/.test(content)
          ? 'createDiscordRest'
          : null,
        /\bdiscordRoutes\b/.test(content) ? 'discordRoutes' : null,
        /\bdiscordApiUrl\b/.test(content) ? 'discordApiUrl' : null,
      ].filter((match): match is string => {
        return Boolean(match)
      })
      if (matches.length === 0) {
        return []
      }
      return [`${relativePath}: ${matches.join(', ')}`]
    })

    expect(violations).toMatchInlineSnapshot(`[]`)
  })
})
