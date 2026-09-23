// Real-process tests for bot shutdown and lock-port recovery.
// Regression: Ctrl+C during startup left the bot alive on the hrana lock port
// (29988), and every next start failed with "still in use after eviction".

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import dedent from 'string-dedent'
import * as errore from 'errore'
import { afterEach, describe, expect, test } from 'vitest'
import { evictExistingInstance } from './hrana-server.js'

const srcDir = path.dirname(fileURLToPath(import.meta.url))
const hranaModule = pathToFileURL(path.join(srcDir, 'hrana-server.ts')).href
const botModule = pathToFileURL(path.join(srcDir, 'discord-bot.ts')).href

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
})

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (!address || typeof address === 'string') {
        reject(new Error('No port assigned'))
        return
      }
      srv.close(() => resolve(address.port))
    })
  })
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
    })
  })
}

// Runs an ESM script through tsx so it can import the real .ts sources.
function startFixture({
  script,
  port,
  ipc = false,
  env = {},
}: {
  script: string
  port: number
  ipc?: boolean
  env?: Record<string, string>
}) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: path.dirname(srcDir),
      env: {
        ...process.env,
        KIMAKI_LOCK_PORT: String(port),
        __KIMAKI_CHILD: ipc ? '1' : undefined,
        ...env,
      },
      stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  let output = ''
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('FIXTURE_READY')) resolve()
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.once('exit', (code, signal) => {
      reject(new Error(`fixture exited early (${code ?? signal}): ${output}`))
    })
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    },
  )
  return { child, ready, exited, output: () => output }
}

function hranaScript({
  extra = '',
  afterReady = '',
}: {
  extra?: string
  afterReady?: string
}) {
  return dedent`
    import os from 'node:os'
    import path from 'node:path'
    import fs from 'node:fs'
    import { startHranaServer } from '${hranaModule}'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-lifecycle-'))
    const result = await startHranaServer({ dbPath: path.join(dir, 'db.sqlite') })
    if (result instanceof Error) throw result
    ${extra}
    // Same situation as the opencode.ts fallback: a listener that never exits.
    process.on('SIGINT', () => {})
    process.on('SIGTERM', () => {})
    console.log('FIXTURE_READY')
    ${afterReady}
    setInterval(() => {}, 1000)
  `
}

// Minimal stand-in for bin.ts: IPC child, respawn on crash, no respawn after
// SIGTERM. Enough to prove eviction targets the wrapper, not just the child.
const WRAPPER_SCRIPT = dedent`
  import { spawn } from 'node:child_process'
  let stopping = false
  let child
  process.on('SIGTERM', () => {
    stopping = true
    child.kill('SIGTERM')
  })
  function start() {
    child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', process.env.CHILD_SCRIPT],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, __KIMAKI_CHILD: '1' } },
    )
    console.log('CHILD_PID=' + child.pid)
    child.on('exit', () => {
      if (stopping) process.exit(0)
      console.log('RESPAWNED')
      start()
    })
  }
  start()
`

function isPidAlive(pid: number): boolean {
  const result = errore.try(() => {
    process.kill(pid, 0)
  })
  return !(result instanceof Error)
}

describe('bot lifecycle', () => {
  test('eviction SIGKILLs an old instance that ignores SIGTERM', async () => {
    const port = await getFreePort()
    const fixture = startFixture({ script: hranaScript({ extra: '' }), port })
    await fixture.ready
    expect(await isPortFree(port)).toBe(false)

    await evictExistingInstance({ port, gracePeriodMs: 500 })

    expect(await fixture.exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(await isPortFree(port)).toBe(true)
  }, 20_000)

  test('eviction stops the old wrapper so it cannot respawn the child', async () => {
    const port = await getFreePort()
    const wrapper = startFixture({
      script: WRAPPER_SCRIPT,
      port,
      env: { CHILD_SCRIPT: hranaScript({}) },
    })
    await wrapper.ready
    const childPid = Number(/CHILD_PID=(\d+)/.exec(wrapper.output())?.[1])

    // The child ignores SIGTERM, so the wrapper's forwarded SIGTERM is not
    // enough and eviction must SIGKILL both, wrapper first.
    await evictExistingInstance({ port, gracePeriodMs: 500 })

    expect(await wrapper.exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(isPidAlive(childPid)).toBe(false)
    expect(wrapper.output()).not.toContain('RESPAWNED')
    expect(await isPortFree(port)).toBe(true)
  }, 20_000)

  test('SIGINT during startup releases the lock port', async () => {
    const port = await getFreePort()
    const fixture = startFixture({
      script: hranaScript({
        extra: dedent`
          const { registerBotLifecycleHandlers } = await import('${botModule}')
          registerBotLifecycleHandlers()
        `,
      }),
      port,
    })
    await fixture.ready

    fixture.child.kill('SIGINT')

    expect(await fixture.exited).toEqual({ code: 0, signal: null })
    expect(await isPortFree(port)).toBe(true)
  }, 30_000)

  test('child shuts down when the wrapper IPC channel closes', async () => {
    const port = await getFreePort()
    const fixture = startFixture({
      script: hranaScript({
        extra: dedent`
          const { registerBotLifecycleHandlers } = await import('${botModule}')
          registerBotLifecycleHandlers()
        `,
      }),
      port,
      ipc: true,
    })
    await fixture.ready

    // Same as the wrapper dying: the OS closes the IPC pipe.
    fixture.child.disconnect()

    expect(await fixture.exited).toEqual({ code: 0, signal: null })
    expect(await isPortFree(port)).toBe(true)
  }, 30_000)

  test('child shuts down if the wrapper died before handlers were registered', async () => {
    const port = await getFreePort()
    const fixture = startFixture({
      script: hranaScript({
        afterReady: dedent`
          await new Promise((resolve) => process.once('disconnect', resolve))
          const { registerBotLifecycleHandlers } = await import('${botModule}')
          registerBotLifecycleHandlers()
        `,
      }),
      port,
      ipc: true,
    })
    await fixture.ready

    fixture.child.disconnect()

    expect(await fixture.exited).toEqual({ code: 0, signal: null })
    expect(await isPortFree(port)).toBe(true)
  }, 30_000)
})
