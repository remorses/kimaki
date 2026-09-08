// Canary Plugin.define. Counts setup() on globalThis across locations.

import { Plugin } from '@opencode-ai/plugin'

const g = globalThis as {
  __kimaki2Probe?: { setups: number; locations: string[] }
}

export function probeState() {
  return g.__kimaki2Probe ?? { setups: 0, locations: [] }
}

export function resetProbeState() {
  g.__kimaki2Probe = { setups: 0, locations: [] }
}

export default Plugin.define({
  id: 'kimaki.probe',
  async setup(ctx) {
    g.__kimaki2Probe ??= { setups: 0, locations: [] }
    g.__kimaki2Probe.setups++
    g.__kimaki2Probe.locations.push(ctx.location.directory)
    return () => {
      const state = g.__kimaki2Probe
      if (!state) return
      state.setups = Math.max(0, state.setups - 1)
    }
  },
})
