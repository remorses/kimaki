// Tests AskUserQuestion request deduplication and cleanup helpers.

import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ThreadChannel } from 'discord.js'
import {
  deletePendingQuestionContextsForRequest,
  pendingQuestionContexts,
  showAskUserQuestionDropdowns,
} from './ask-question.js'

function createFakeThread(): ThreadChannel {
  const send = vi.fn(async () => {
    return { id: 'msg-1' }
  })

  return {
    id: 'thread-1',
    send,
  } as unknown as ThreadChannel
}

afterEach(() => {
  pendingQuestionContexts.clear()
  vi.restoreAllMocks()
})

describe('ask-question', () => {
  test('dedupes duplicate question requests for the same thread', async () => {
    const thread = createFakeThread()

    await showAskUserQuestionDropdowns({
      thread,
      sessionId: 'ses-1',
      directory: '/project',
      requestId: 'req-1',
      input: {
        questions: [{
          question: 'Choose one',
          header: 'Pick',
          options: [
            { label: 'Alpha', description: 'A' },
            { label: 'Beta', description: 'B' },
          ],
        }],
      },
    })

    await showAskUserQuestionDropdowns({
      thread,
      sessionId: 'ses-1',
      directory: '/project',
      requestId: 'req-1',
      input: {
        questions: [{
          question: 'Choose one',
          header: 'Pick',
          options: [
            { label: 'Alpha', description: 'A' },
            { label: 'Beta', description: 'B' },
          ],
        }],
      },
    })

    expect(thread.send).toHaveBeenCalledTimes(1)
    expect(pendingQuestionContexts.size).toBe(1)
  })

  test('removes all duplicate contexts for one request', () => {
    const thread = createFakeThread()
    const baseContext: typeof pendingQuestionContexts extends Map<string, infer T>
      ? T
      : never = {
      sessionId: 'ses-1',
      directory: '/project',
      thread,
      requestId: 'req-1',
      questions: [{
        question: 'Choose one',
        header: 'Pick',
        options: [
          { label: 'Alpha', description: 'A' },
          { label: 'Beta', description: 'B' },
        ],
      }],
      answers: {},
      totalQuestions: 1,
      answeredCount: 0,
      contextHash: 'ctx-1',
    }

    pendingQuestionContexts.set('ctx-1', baseContext)
    pendingQuestionContexts.set('ctx-2', {
      ...baseContext,
      contextHash: 'ctx-2',
    })
    pendingQuestionContexts.set('ctx-3', {
      ...baseContext,
      requestId: 'req-2',
      contextHash: 'ctx-3',
    })

    const removed = deletePendingQuestionContextsForRequest({
      threadId: thread.id,
      requestId: 'req-1',
    })

    expect(removed).toBe(2)
    expect([...pendingQuestionContexts.keys()]).toEqual(['ctx-3'])
  })
})
