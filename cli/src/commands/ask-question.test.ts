// Tests AskUserQuestion request deduplication and cleanup helpers.

import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ThreadChannel } from 'discord.js'
import {
  areAllQuestionsAnswered,
  deletePendingQuestionContextsForRequest,
  pendingQuestionContexts,
  showAskUserQuestionDropdowns,
} from './ask-question.js'

function createFakeThread({ failSend }: { failSend?: boolean } = {}): ThreadChannel {
  const send = vi.fn(async () => {
    if (failSend) {
      throw new Error('Missing Permissions')
    }
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

  test('does not schedule a question expiry timer', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    await showAskUserQuestionDropdowns({
      thread: createFakeThread(),
      sessionId: 'ses-1',
      directory: '/project',
      requestId: 'req-no-ttl',
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

    expect(timeoutSpy).not.toHaveBeenCalled()
  })

  test('drops the context when the dropdown message fails to send', async () => {
    await showAskUserQuestionDropdowns({
      thread: createFakeThread({ failSend: true }),
      sessionId: 'ses-1',
      directory: '/project',
      requestId: 'req-send-fails',
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

    expect(pendingQuestionContexts.size).toBe(0)
  })

  test('requires every question to have an answer', () => {
    expect(areAllQuestionsAnswered({
      totalQuestions: 3,
      answers: {
        0: ['Alpha'],
        2: ['Gamma'],
      },
    })).toBe(false)

    expect(areAllQuestionsAnswered({
      totalQuestions: 3,
      answers: {
        0: ['Alpha'],
        1: ['Beta'],
        2: ['Gamma'],
      },
    })).toBe(true)
  })
})
