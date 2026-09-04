// Tests for live CPU profiling via stdin `cpuprof` and node:inspector.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setDataDir } from './config.js'
import {
  CPU_PROF_AUTO_STOP_MS,
  handleStdinLine,
  isCpuProfiling,
  parseStdinCommand,
  startCpuProfiling,
  startStdinCpuProfListener,
  stopCpuProfiling,
  stopStdinCpuProfListener,
  toggleCpuProfiling,
  flushCpuProfiling,
  _resetCpuProfilerForTests,
} from './cpu-profiler.js'

const tempDirs: string[] = []

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-cpu-profiler-'))
  tempDirs.push(dir)
  setDataDir(dir)
  return dir
}

function cpuProfileDir(dataDir: string) {
  return path.join(dataDir, 'cpu-profiles')
}

function listProfiles(dataDir: string) {
  const dir = cpuProfileDir(dataDir)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.endsWith('.cpuprofile'))
}

function burnCpu(ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) Math.sqrt(Math.random())
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for condition')
}

beforeEach(() => {
  makeDataDir()
})

afterEach(async () => {
  await _resetCpuProfilerForTests()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseStdinCommand', () => {
  test('matches cpuprof after trim, ignoring case', () => {
    expect(parseStdinCommand('cpuprof')).toBe('cpuprof')
    expect(parseStdinCommand('  CPUProf \n')).toBe('cpuprof')
    expect(parseStdinCommand('cpuprof now')).toBeNull()
    expect(parseStdinCommand('heap')).toBeNull()
  })
})

describe.sequential('cpu profiler', () => {
  test('auto-stop default is 20 seconds', () => {
    expect(CPU_PROF_AUTO_STOP_MS).toBe(20_000)
  })

  test('start then stop writes a chrome cpuprofile under the data dir', async () => {
    const dataDir = makeDataDir()
    const started = await startCpuProfiling({ autoStopMs: 10_000 })
    expect(started).not.toBeInstanceOf(Error)
    expect(isCpuProfiling()).toBe(true)
    burnCpu(50)
    const stopped = await stopCpuProfiling()
    expect(stopped).not.toBeInstanceOf(Error)
    if (stopped instanceof Error) return
    expect(isCpuProfiling()).toBe(false)
    expect(stopped.path.startsWith(cpuProfileDir(dataDir))).toBe(true)
    expect(stopped.path).toMatch(/cpu-.*\.cpuprofile$/)
    expect(fs.existsSync(stopped.path)).toBe(true)
    const profile = JSON.parse(fs.readFileSync(stopped.path, 'utf8'))
    expect(Array.isArray(profile.nodes)).toBe(true)
    expect(listProfiles(dataDir)).toEqual([path.basename(stopped.path)])
  })

  test('start while already running returns an error', async () => {
    const started = await startCpuProfiling({ autoStopMs: 10_000 })
    expect(started).not.toBeInstanceOf(Error)
    const again = await startCpuProfiling({ autoStopMs: 10_000 })
    expect(again).toBeInstanceOf(Error)
    expect(isCpuProfiling()).toBe(true)
  })

  test('stop while idle returns an error', async () => {
    const stopped = await stopCpuProfiling()
    expect(stopped).toBeInstanceOf(Error)
  })

  test('toggle starts then stops', async () => {
    const dataDir = makeDataDir()
    const started = await toggleCpuProfiling({ autoStopMs: 10_000 })
    expect(started).not.toBeInstanceOf(Error)
    if (started instanceof Error) return
    expect(started.action).toBe('started')
    expect(isCpuProfiling()).toBe(true)
    burnCpu(30)
    const stopped = await toggleCpuProfiling({ autoStopMs: 10_000 })
    expect(stopped).not.toBeInstanceOf(Error)
    if (stopped instanceof Error) return
    expect(stopped.action).toBe('stopped')
    if (stopped.action !== 'stopped') return
    expect(fs.existsSync(stopped.path)).toBe(true)
    expect(listProfiles(dataDir)).toHaveLength(1)
  })

  test('auto-stops after the timeout and writes a profile', async () => {
    const dataDir = makeDataDir()
    const started = await startCpuProfiling({ autoStopMs: 80 })
    expect(started).not.toBeInstanceOf(Error)
    await waitUntil(() => listProfiles(dataDir).length === 1)
    expect(isCpuProfiling()).toBe(false)
  })

  test('flush waits for an in-flight start and writes one profile', async () => {
    const dataDir = makeDataDir()
    const starting = startCpuProfiling({ autoStopMs: 10_000 })
    const flushing = flushCpuProfiling()
    await starting
    const result = await flushing
    expect(result).not.toBeInstanceOf(Error)
    expect(listProfiles(dataDir)).toHaveLength(1)
    expect(isCpuProfiling()).toBe(false)
  })
})

describe.sequential('stdin cpuprof', () => {
  test('handleStdinLine starts and stops on cpuprof', async () => {
    const dataDir = makeDataDir()
    const first = await handleStdinLine('cpuprof', { autoStopMs: 10_000 })
    expect(first).not.toBeInstanceOf(Error)
    expect(first).not.toBeNull()
    if (first instanceof Error || !first) return
    expect(first.action).toBe('started')
    burnCpu(30)
    const second = await handleStdinLine('cpuprof', { autoStopMs: 10_000 })
    expect(second).not.toBeInstanceOf(Error)
    expect(second).not.toBeNull()
    if (second instanceof Error || !second) return
    expect(second.action).toBe('stopped')
    expect(listProfiles(dataDir)).toHaveLength(1)
  })

  test('handleStdinLine ignores unrelated input', async () => {
    expect(await handleStdinLine('help')).toBeNull()
    expect(isCpuProfiling()).toBe(false)
  })

  test('stdin listener toggles on cpuprof lines', async () => {
    const dataDir = makeDataDir()
    const stdin = new PassThrough()
    startStdinCpuProfListener({ stdin, autoStopMs: 10_000 })
    stdin.write('cpuprof\n')
    await waitUntil(() => isCpuProfiling())
    burnCpu(30)
    stdin.write('cpuprof\n')
    await waitUntil(() => !isCpuProfiling())
    expect(listProfiles(dataDir)).toHaveLength(1)
    stopStdinCpuProfListener()
  })
})
