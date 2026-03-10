// Guardrail test for adapter boundary imports.
// Runtime modules must not import discord.js directly outside the Discord adapter,
// forum-sync bridge, and voice handler.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC_DIR = path.resolve(import.meta.dirname)

function collectTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return collectTsFiles(fullPath)
    }
    if (!entry.name.endsWith('.ts')) {
      return []
    }
    if (entry.name.endsWith('.test.ts')) {
      return []
    }
    if (entry.name.includes('e2e')) {
      return []
    }
    return [fullPath]
  })
}

function toWorkspaceRelative(filePath: string): string {
  return path.relative(path.resolve(import.meta.dirname, '..'), filePath)
}

function isAllowedBoundaryFile(relativePath: string): boolean {
  if (relativePath === 'src/platform/discord-adapter.ts') {
    return true
  }
  if (relativePath === 'src/voice-handler.ts') {
    return true
  }
  if (relativePath.startsWith('src/forum-sync/')) {
    return true
  }
  return false
}

describe('discord.js import boundary', () => {
  test('does not import discord.js outside allowed modules', () => {
    const violations = collectTsFiles(SRC_DIR)
      .map((filePath) => {
        return {
          relativePath: toWorkspaceRelative(filePath),
          content: fs.readFileSync(filePath, 'utf8'),
        }
      })
      .filter(({ relativePath }) => {
        return !isAllowedBoundaryFile(relativePath)
      })
      .filter(({ content }) => {
        return /from\s+['"]discord\.js['"]/.test(content)
      })
      .map(({ relativePath }) => {
        return relativePath
      })

    expect(violations).toMatchInlineSnapshot(`[]`)
  })
})
