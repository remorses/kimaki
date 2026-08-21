import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { waitAndOutputExistingSession, waitAndOutputSession } from './wait-session.js'

const { generate, initializeOpencodeForDirectory, stdoutWrite } = vi.hoisted(() => ({
  generate: vi.fn(async () => 'latest assistant output'),
  initializeOpencodeForDirectory: vi.fn(),
  stdoutWrite: vi.fn(() => true),
}))

vi.mock('./database.js', () => ({
  getSessionEventSnapshot: vi.fn(async () => []),
  getThreadSession: vi.fn(async () => 'ses_wait'),
}))

vi.mock('./opencode.js', () => ({ initializeOpencodeForDirectory }))

vi.mock('./markdown.js', () => ({
  ShareMarkdown: class {
    generate = generate
  },
}))

beforeEach(() => {
  vi.useFakeTimers()
  initializeOpencodeForDirectory.mockResolvedValue(() => ({
    session: {
      status: vi.fn(async () => ({ data: { ses_wait: { type: 'idle' } } })),
      messages: vi.fn(async () => ({
        data: [
          {
            info: {
              id: 'user',
              sessionID: 'ses_wait',
              role: 'user',
              time: { created: 1 },
            },
            parts: [],
          },
          {
            info: {
              id: 'assistant',
              sessionID: 'ses_wait',
              role: 'assistant',
              parentID: 'user',
              time: { created: 2, completed: 3 },
              finish: 'stop',
            },
            parts: [],
          },
        ],
      })),
    },
  }))
  vi.spyOn(process.stdout, 'write').mockImplementation(stdoutWrite)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  generate.mockClear()
  initializeOpencodeForDirectory.mockClear()
})

test('passes last-assistant-only through existing-session wait output', async () => {
  const result = waitAndOutputExistingSession({
    sessionId: 'ses_wait',
    projectDirectory: '/project',
    lastAssistantOnly: true,
  })

  await vi.advanceTimersByTimeAsync(5_000)
  await result

  expect(generate).toHaveBeenCalledWith({
    sessionID: 'ses_wait',
    lastAssistantOnly: true,
  })
  expect(stdoutWrite).toHaveBeenCalledWith('latest assistant output')
})

test('keeps send wait output on the default full-session renderer path', async () => {
  const result = waitAndOutputSession({
    threadId: 'thread_wait',
    projectDirectory: '/project',
  })

  await vi.advanceTimersByTimeAsync(5_000)
  await result

  expect(generate).toHaveBeenCalledWith({ sessionID: 'ses_wait' })
})
