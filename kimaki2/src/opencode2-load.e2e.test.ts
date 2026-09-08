// Load kimaki.probe on a real opencode2 server. Two folders, one PID.

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import { opencodeApi, pluginDirs, spawnOpencode2 } from './opencode2-serve.ts'

const ROOT = path.resolve(process.cwd())
const PROBE_DIR = pluginDirs().probe

test('opencode2 loads probe once per folder in one process', async () => {
  fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true })
  const run = fs.mkdtempSync(path.join(ROOT, 'tmp', 'opencode2-load-'))
  const home = path.join(run, 'home')
  const probeLog = path.join(run, 'probe.jsonl')
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugins: [] }),
  )

  const projectA = path.join(run, 'project-a')
  const projectB = path.join(run, 'project-b')
  for (const directory of [projectA, projectB]) {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(
      path.join(directory, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        plugins: [PROBE_DIR],
      }),
    )
  }

  const server = await spawnOpencode2({
    cwd: run,
    home,
    extraEnv: { KIMAKI2_PROBE_LOG: probeLog },
  })

  try {
    const waitA = await opencodeApi({
      url: server.serve.url,
      password: server.serve.password,
      method: 'POST',
      path: '/api/plugin/await-activation',
      directory: projectA,
    })
    expect(waitA.status).toBeGreaterThanOrEqual(200)
    expect(waitA.status).toBeLessThan(300)
    const waitB = await opencodeApi({
      url: server.serve.url,
      password: server.serve.password,
      method: 'POST',
      path: '/api/plugin/await-activation',
      directory: projectB,
    })
    expect(waitB.status).toBeGreaterThanOrEqual(200)
    expect(waitB.status).toBeLessThan(300)

    const listA = await opencodeApi({
      url: server.serve.url,
      password: server.serve.password,
      method: 'GET',
      path: '/api/plugin',
      directory: projectA,
    })
    const plugins = Array.isArray(listA.body?.data) ? listA.body.data : listA.body
    const probe = (plugins as Array<{ id?: string; state?: { status?: string } | string }>).find(
      (item) => item.id === 'kimaki.probe',
    )
    const state = probe?.state
    const status = typeof state === 'string' ? state : state?.status
    expect(status).toBe('active')

    const lines = fs.readFileSync(probeLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; pid: number; directory?: string; setups?: number })
    const setups = lines.filter((line) => line.event === 'setup')
    expect(setups).toHaveLength(2)
    expect(new Set(setups.map((line) => line.pid)).size).toBe(1)
    expect(setups.map((line) => line.directory).sort()).toEqual([projectA, projectB].sort())
    expect(setups.some((line) => line.setups === 1)).toBe(true)
    expect(setups.some((line) => line.setups === 2)).toBe(true)
  } finally {
    await server.stop()
  }
}, 30_000)
