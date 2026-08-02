// Tests AskUserQuestion request deduplication and cleanup helpers.

import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ThreadChannel } from 'discord.js'
import {
  areAllQuestionsAnswered,
  deletePendingQuestionContextsForRequest,
  pendingQuestionContexts,
  resolveSelectedOptionCommand,
  showAskUserQuestionDropdowns,
  type AskUserQuestionInput,
} from './ask-question.js'
import type { RegisteredUserCommand } from '../store.js'

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

describe('resolveSelectedOptionCommand', () => {
  const registered: RegisteredUserCommand[] = [
    {
      name: 'start-work',
      discordCommandName: 'start-work',
      description: 'start a work session',
      source: 'command',
    },
  ]

  const handoffQuestions: AskUserQuestionInput['questions'] = [
    {
      question: 'Plan ready. What next?',
      header: 'Handoff',
      options: [
        {
          label: 'Start Work',
          description: 'Execute now with `/start-work {name}`. Plan looks solid.',
        },
        {
          label: 'High Accuracy Review',
          description: 'Run an extra review pass before executing.',
        },
      ],
    },
  ]

  test('returns the command for a command-bearing option', () => {
    expect(
      resolveSelectedOptionCommand({
        questions: handoffQuestions,
        totalQuestions: 1,
        questionIndex: 0,
        selectedValues: ['0'],
        registered,
      }),
    ).toEqual({ name: 'start-work', arguments: '' })
  })

  test('returns null for an option without a command', () => {
    expect(
      resolveSelectedOptionCommand({
        questions: handoffQuestions,
        totalQuestions: 1,
        questionIndex: 0,
        selectedValues: ['1'],
        registered,
      }),
    ).toBeNull()
  })

  test('ignores multi-question forms', () => {
    expect(
      resolveSelectedOptionCommand({
        questions: handoffQuestions,
        totalQuestions: 2,
        questionIndex: 0,
        selectedValues: ['0'],
        registered,
      }),
    ).toBeNull()
  })

  test('ignores multi-select answers', () => {
    expect(
      resolveSelectedOptionCommand({
        questions: handoffQuestions,
        totalQuestions: 1,
        questionIndex: 0,
        selectedValues: ['0', '1'],
        registered,
      }),
    ).toBeNull()
  })

  test('ignores the free-text "Other" choice', () => {
    expect(
      resolveSelectedOptionCommand({
        questions: handoffQuestions,
        totalQuestions: 1,
        questionIndex: 0,
        selectedValues: ['other'],
        registered,
      }),
    ).toBeNull()
  })
})
