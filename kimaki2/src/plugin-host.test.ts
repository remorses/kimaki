import { afterEach, expect, test } from 'vitest'
import { Location } from '@opencode-ai/plugin'
import { activatePlugin, host } from './plugin-host.ts'
import probe, { probeState, resetProbeState } from './plugins/probe.ts'

afterEach(() => {
  resetProbeState()
})

function location(directory: string) {
  return new Location.Info({
    directory: directory as Location.Info['directory'],
    project: {
      id: 'global' as Location.Info['project']['id'],
      directory: directory as Location.Info['directory'],
      canonical: directory as Location.Info['directory'],
    },
  })
}

test('setup runs and cleanup decrements the process counter', async () => {
  const ctx = host()
  const active = await activatePlugin({ plugin: probe, ctx })
  expect(probeState().setups).toBe(1)
  await active.dispose()
  expect(probeState().setups).toBe(0)
})

test('two directories share globalThis and each call setup', async () => {
  const a = await activatePlugin({
    plugin: probe,
    ctx: host({ location: location('/tmp/a') }),
  })
  const b = await activatePlugin({
    plugin: probe,
    ctx: host({ location: location('/tmp/b') }),
  })
  expect(probeState()).toMatchObject({
    setups: 2,
    locations: ['/tmp/a', '/tmp/b'],
  })
  await a.dispose()
  await b.dispose()
})
