// Tests for context-awareness directory switch reminders.

import { describe, expect, test } from 'vitest'
import {
  shouldInjectPwd,
  shouldInjectMemoryReminderFromLatestAssistant,
} from './context-awareness-plugin.js'

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
      [working directory changed (cwd / pwd has changed). The user expects you to edit files in the new cwd. Previous folder (DO NOT TOUCH): /repo/main. New folder (new cwd / pwd, edit files here): /repo/worktree. You MUST read, write, and edit files only under the new folder /repo/worktree. You MUST NOT read, write, or edit any files under the previous folder /repo/main — that folder is a separate checkout and the user or another agent may be actively working there, so writing to it would override their unrelated changes.]
      ",
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
      [working directory changed (cwd / pwd has changed). The user expects you to edit files in the new cwd. Previous folder (DO NOT TOUCH): /repo/worktree-a. New folder (new cwd / pwd, edit files here): /repo/worktree-b. You MUST read, write, and edit files only under the new folder /repo/worktree-b. You MUST NOT read, write, or edit any files under the previous folder /repo/worktree-a — that folder is a separate checkout and the user or another agent may be actively working there, so writing to it would override their unrelated changes.]
      ",
      }
    `)
  })
})

describe('shouldInjectMemoryReminderFromLatestAssistant', () => {
  test('does not trigger before threshold', () => {
    const result = shouldInjectMemoryReminderFromLatestAssistant({
      latestAssistantMessage: {
        id: 'msg_asst_1',
        role: 'assistant',
        time: { completed: 1 },
        tokens: {
          input: 1_000,
          output: 3_000,
          reasoning: 500,
          cache: { read: 0, write: 0 },
        },
      },
      threshold: 10_000,
    })

    expect(result).toMatchInlineSnapshot(`
      {
        "inject": false,
      }
    `)
  })

  test('triggers when latest assistant message exceeds threshold', () => {
    const result = shouldInjectMemoryReminderFromLatestAssistant({
      latestAssistantMessage: {
        id: 'msg_asst_2',
        role: 'assistant',
        time: { completed: 2 },
        tokens: {
          input: 2_000,
          output: 2_200,
          reasoning: 400,
          cache: { read: 0, write: 0 },
        },
      },
      threshold: 2_000,
    })

    expect(result).toMatchInlineSnapshot(`
      {
        "assistantMessageId": "msg_asst_2",
        "inject": true,
      }
    `)
  })

  test('does not trigger again for the same reminded assistant message', () => {
    const result = shouldInjectMemoryReminderFromLatestAssistant({
      lastMemoryReminderAssistantMessageId: 'msg_asst_3',
      latestAssistantMessage: {
        id: 'msg_asst_3',
        role: 'assistant',
        time: { completed: 3 },
        tokens: {
          input: 2_000,
          output: 2_200,
          reasoning: 400,
          cache: { read: 0, write: 0 },
        },
      },
      threshold: 10_000,
    })

    expect(result).toMatchInlineSnapshot(`
      {
        "inject": false,
      }
    `)
  })
})
