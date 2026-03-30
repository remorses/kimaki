// Tests for context-awareness directory switch reminders.

import { describe, expect, test } from 'vitest'
import { shouldInjectPwd } from './context-awareness-plugin.js'

describe('shouldInjectPwd', () => {
  test('does not inject when current directory matches announced directory', () => {
    const result = shouldInjectPwd({
      currentDir: '/repo/worktree',
      previousDir: '/repo/main',
      announcedDir: '/repo/worktree',
    })

    expect(result).toMatchInlineSnapshot(`
      {
        "inject": false,
      }
    `)
  })

  test('does not inject without a previous directory to warn about', () => {
    const result = shouldInjectPwd({
      currentDir: '/repo/worktree',
      previousDir: undefined,
      announcedDir: undefined,
    })

    expect(result).toMatchInlineSnapshot(`
      {
        "inject": false,
      }
    `)
  })

  test('names previous and current directories in the correct order', () => {
    const result = shouldInjectPwd({
      currentDir: '/repo/worktree',
      previousDir: '/repo/main',
      announcedDir: undefined,
    })

    expect(result).toMatchInlineSnapshot(`
      {
        "inject": true,
        "text": "
      [working directory changed. Previous working directory: /repo/main. Current working directory: /repo/worktree. You MUST read, write, and edit files only under /repo/worktree. Do NOT read, write, or edit files under /repo/main.]",
      }
    `)
  })

  test('prefers the last announced directory as the previous directory', () => {
    const result = shouldInjectPwd({
      currentDir: '/repo/worktree-b',
      previousDir: '/repo/main',
      announcedDir: '/repo/worktree-a',
    })

    expect(result).toMatchInlineSnapshot(`
      {
        "inject": true,
        "text": "
      [working directory changed. Previous working directory: /repo/worktree-a. Current working directory: /repo/worktree-b. You MUST read, write, and edit files only under /repo/worktree-b. Do NOT read, write, or edit files under /repo/worktree-a.]",
      }
    `)
  })
})
