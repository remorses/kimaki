import { afterEach, describe, expect, test } from 'vitest'
import {
  buildHtmlActionCustomId,
  cancelHtmlActionsForOwner,
  cancelHtmlActionsForThread,
  pendingHtmlActions,
  registerHtmlAction,
} from './html-actions.js'

const TEST_OWNER_A = 'worktrees:user-a:channel-a'
const TEST_OWNER_B = 'worktrees:user-b:channel-a'

afterEach(() => {
  cancelHtmlActionsForOwner(TEST_OWNER_A)
  cancelHtmlActionsForOwner(TEST_OWNER_B)
})

describe('html action registry', () => {
  test('registers action ids with expected custom id prefix', () => {
    const actionId = registerHtmlAction({
      ownerKey: TEST_OWNER_A,
      run: async () => {
        return undefined
      },
    })

    expect(buildHtmlActionCustomId(actionId)).toMatch(/^html_action:/)
    expect(pendingHtmlActions.has(actionId)).toBe(true)
  })

  test('cancels actions by owner', () => {
    registerHtmlAction({
      ownerKey: TEST_OWNER_A,
      run: async () => {
        return undefined
      },
    })
    registerHtmlAction({
      ownerKey: TEST_OWNER_A,
      run: async () => {
        return undefined
      },
    })

    expect(cancelHtmlActionsForOwner(TEST_OWNER_A)).toBe(2)
    expect(pendingHtmlActions.size).toBe(0)
  })

  test('cancels only actions from the matching thread', () => {
    const threadAActionId = registerHtmlAction({
      ownerKey: TEST_OWNER_A,
      threadId: 'thread-a',
      run: async () => {
        return undefined
      },
    })
    const threadBActionId = registerHtmlAction({
      ownerKey: TEST_OWNER_B,
      threadId: 'thread-b',
      run: async () => {
        return undefined
      },
    })

    expect(cancelHtmlActionsForThread('thread-a')).toBe(1)
    expect(pendingHtmlActions.has(threadAActionId)).toBe(false)
    expect(pendingHtmlActions.has(threadBActionId)).toBe(true)
  })

  test('expires actions after ttl', async () => {
    const actionId = registerHtmlAction({
      ownerKey: TEST_OWNER_A,
      ttlMs: 10,
      run: async () => {
        return undefined
      },
    })

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve()
      }, 30)
    })

    expect(pendingHtmlActions.has(actionId)).toBe(false)
  })
})
