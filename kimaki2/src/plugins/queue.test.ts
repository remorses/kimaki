import { expect, test } from 'vitest'
import { extractQueueSuffix } from '../queue-suffix.ts'
import { activatePlugin, host, promptEvent } from '../plugin-host.ts'
import queue from '../../opencode-plugins/queue/index.ts'
import type { SessionPrompt } from '@opencode-ai/plugin/promise/session'

test('suffix queue sets delivery queue and strips the marker', async () => {
  const hooks: Array<(event: SessionPrompt) => void> = []
  const ctx = host({
    session: {
      hook: async (name, callback) => {
        if (name === 'prompt') hooks.push(callback)
        return { dispose: async () => {} }
      },
    },
  })
  await activatePlugin({ plugin: queue, ctx })
  const event = promptEvent({ text: 'fix the footer. queue' })
  for (const hook of hooks) hook(event)
  expect(event.delivery).toBe('queue')
  expect(event.prompt.text).toBe('fix the footer')
})

test('explicit queue delivery stays queue without a suffix', async () => {
  const hooks: Array<(event: SessionPrompt) => void> = []
  const ctx = host({
    session: {
      hook: async (name, callback) => {
        if (name === 'prompt') hooks.push(callback)
        return { dispose: async () => {} }
      },
    },
  })
  await activatePlugin({ plugin: queue, ctx })
  const event = promptEvent({ text: 'queued by slash command', delivery: 'queue' })
  for (const hook of hooks) hook(event)
  expect(event.delivery).toBe('queue')
  expect(event.prompt.text).toBe('queued by slash command')
})

test('plain text without suffix leaves default steer', async () => {
  const hooks: Array<(event: SessionPrompt) => void> = []
  const ctx = host({
    session: {
      hook: async (name, callback) => {
        if (name === 'prompt') hooks.push(callback)
        return { dispose: async () => {} }
      },
    },
  })
  await activatePlugin({ plugin: queue, ctx })
  const event = promptEvent({ text: 'hello' })
  for (const hook of hooks) hook(event)
  expect(event.delivery).toBe('steer')
  expect(event.prompt.text).toBe('hello')
})

test('extractQueueSuffix keeps non-suffix queue words', () => {
  expect(extractQueueSuffix('queue this later')).toEqual({
    prompt: 'queue this later',
    forceQueue: false,
  })
  expect(extractQueueSuffix('ok\nqueue')).toEqual({
    prompt: 'ok',
    forceQueue: true,
  })
})
