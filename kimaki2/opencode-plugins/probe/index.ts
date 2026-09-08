// Real OpenCode v2 plugin. Loaded by opencode2 serve, not by the fake host.
// Logs module-eval and setup() to KIMAKI2_PROBE_LOG so tests can prove per-location boot.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Plugin } from '@opencode-ai/plugin'

const LOG = process.env['KIMAKI2_PROBE_LOG'] ?? '/tmp/kimaki2-probe.jsonl'
const PID = process.pid
const g = globalThis as {
  __kimaki2OpencodeProbe?: { setups: number; locations: string[] }
}

function log(event: string, extra: Record<string, string | number | boolean | string[] | null> = {}) {
  mkdirSync(dirname(LOG), { recursive: true })
  appendFileSync(
    LOG,
    JSON.stringify({ ts: new Date().toISOString(), pid: PID, event, ...extra }) + '\n',
  )
}

g.__kimaki2OpencodeProbe ??= { setups: 0, locations: [] }
log('module-eval', {
  setups: g.__kimaki2OpencodeProbe.setups,
  importMeta: import.meta.url,
})

export default Plugin.define({
  id: 'kimaki.probe',
  async setup(ctx) {
    const host = g.__kimaki2OpencodeProbe!
    host.setups++
    const directory = ctx.location.directory
    host.locations.push(directory)
    log('setup', {
      setups: host.setups,
      directory,
      firstSetupForProcess: host.setups === 1,
      locations: [...host.locations],
    })
    return () => {
      log('cleanup', { directory, setups: host.setups })
    }
  },
})
