import { beforeEach, describe, expect, test, vi } from 'vitest'

const { getThreadIdBySessionId } = vi.hoisted(() => ({
  getThreadIdBySessionId: vi.fn(),
}))

vi.mock('./database.js', () => ({ getThreadIdBySessionId }))

import { sessionAttributionPlugin } from './session-attribution-plugin.js'

async function getShellEnvHook() {
  const plugin = await sessionAttributionPlugin({} as never)
  const hook = plugin['shell.env']
  if (!hook) throw new Error('missing shell.env hook')
  return hook
}

async function shellEnv(hook: Awaited<ReturnType<typeof getShellEnvHook>>, sessionID?: string) {
  const output = { env: { EXISTING_VALUE: 'preserved' } }
  await hook({ cwd: '/project', sessionID }, output)
  return output.env
}

describe('sessionAttributionPlugin', () => {
  beforeEach(() => {
    getThreadIdBySessionId.mockReset()
  })

  test('scopes concurrent shell environments to their Discord threads', async () => {
    getThreadIdBySessionId.mockImplementation(async (sessionID: string) => {
      return sessionID === 'session-one' ? 'thread-one' : 'thread-two'
    })
    const hook = await getShellEnvHook()

    const [first, second] = await Promise.all([
      shellEnv(hook, 'session-one'),
      shellEnv(hook, 'session-two'),
    ])

    expect(first).toEqual({
      EXISTING_VALUE: 'preserved',
      KIMAKI_THREAD_ID: 'thread-one',
    })
    expect(second).toEqual({
      EXISTING_VALUE: 'preserved',
      KIMAKI_THREAD_ID: 'thread-two',
    })
  })

  test('leaves manual and unknown sessions unattributed', async () => {
    getThreadIdBySessionId.mockResolvedValue(undefined)
    const hook = await getShellEnvHook()

    await expect(shellEnv(hook)).resolves.toEqual({
      EXISTING_VALUE: 'preserved',
    })
    await expect(shellEnv(hook, 'unknown')).resolves.toEqual({
      EXISTING_VALUE: 'preserved',
    })
    expect(getThreadIdBySessionId).toHaveBeenCalledOnce()
  })

  test('leaves the shell environment unchanged when attribution is unavailable', async () => {
    getThreadIdBySessionId.mockRejectedValue(new Error('database unavailable'))
    const hook = await getShellEnvHook()

    await expect(shellEnv(hook, 'session-one')).resolves.toEqual({
      EXISTING_VALUE: 'preserved',
    })
  })
})
