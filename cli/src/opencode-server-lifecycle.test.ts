// OpenCode child lifecycle: intentional stop must not restart, and a child
// that dies during boot must fail startup on the next poll with stderr.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import dedent from 'string-dedent'
import { setDataDir } from './config.js'
import { ServerStartError } from './errors.js'
import {
  getOpencodeServerPort,
  initializeOpencodeForDirectory,
  stopOpencodeServer,
  subscribeOpencodeServerLifecycle,
  waitForServer,
} from './opencode.js'
import { store } from './store.js'
import { chooseLockPort } from './test-utils.js'

const EXIT_130_JS = dedent`
  #!/usr/bin/env node
  import fs from 'node:fs'
  import http from 'node:http'
  import path from 'node:path'

  const portFlag = process.argv.indexOf('--port')
  const port = Number(process.argv[portFlag + 1])
  if (!Number.isInteger(port)) {
    process.stderr.write('fake opencode: missing --port\\n')
    process.exit(1)
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('[]')
  })
  server.listen(port, '127.0.0.1')
  process.stderr.write('fake opencode: listening\\n')

  process.on('SIGTERM', () => {
    server.close()
    const releaseFile = process.env.KIMAKI_TEST_RELEASE_FILE
    if (!releaseFile || fs.existsSync(releaseFile)) process.exit(130)
    const watcher = fs.watch(path.dirname(releaseFile), (_event, fileName) => {
      if (fileName !== path.basename(releaseFile)) return
      watcher.close()
      process.exit(130)
    })
  })

  process.on('exit', () => {
    const exitFile = process.env.KIMAKI_TEST_EXIT_FILE
    if (exitFile) fs.writeFileSync(exitFile, 'exited')
  })
`

const CRASH_JS = dedent`
  #!/usr/bin/env node
  process.stderr.write('fake opencode: bind failed on purpose\\n')
  process.exit(1)
`

const HANG_BEFORE_LISTEN_JS = dedent`
  #!/usr/bin/env node
  import fs from 'node:fs'
  import path from 'node:path'

  const pidFile = process.env.KIMAKI_TEST_PID_FILE
  if (pidFile) fs.writeFileSync(pidFile, String(process.pid))
  process.stderr.write('fake opencode: hanging before listen\\n')
  setInterval(() => {}, 2 ** 31 - 1)

  process.on('SIGTERM', () => {
    const releaseFile = process.env.KIMAKI_TEST_RELEASE_FILE
    if (!releaseFile || fs.existsSync(releaseFile)) process.exit(130)
    const watcher = fs.watch(path.dirname(releaseFile), (_event, fileName) => {
      if (fileName !== path.basename(releaseFile)) return
      watcher.close()
      process.exit(130)
    })
  })
`

function waitForFile(filePath: string) {
  return new Promise<void>((resolve, reject) => {
    if (fs.existsSync(filePath)) {
      resolve()
      return
    }
    const directory = path.dirname(filePath)
    const timeout = setTimeout(() => {
      watcher.close()
      reject(new Error(`Timed out waiting for ${filePath}`))
    }, 5_000)
    const watcher = fs.watch(directory, () => {
      if (!fs.existsSync(filePath)) return
      clearTimeout(timeout)
      watcher.close()
      resolve()
    })
  })
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function writeFakeOpencode({ contents, fileName }: { contents: string; fileName: string }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-opencode-lifecycle-'))
  const filePath = path.join(directory, fileName)
  fs.writeFileSync(filePath, contents, { mode: 0o755 })
  return { directory, filePath }
}

function listenOnEphemeralPort() {
  return new Promise<number>((resolve, reject) => {
    const server = http.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to get ephemeral port'))
          return
        }
        resolve(address.port)
      })
    })
    server.on('error', reject)
  })
}

describe('OpenCode server lifecycle', () => {
  let sandbox = ''
  let previousOpencode2Path: string | undefined
  let previousOpencodePath: string | undefined
  const fakeDirs: string[] = []

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-opencode-lifecycle-data-'))
    setDataDir(path.join(sandbox, 'data'))
    process.env['KIMAKI_LOCK_PORT'] = String(
      chooseLockPort({ key: `opencode-server-lifecycle-${process.pid}` }),
    )
    previousOpencode2Path = process.env.OPENCODE2_PATH
    previousOpencodePath = process.env.OPENCODE_PATH
    delete process.env.KIMAKI_TEST_RELEASE_FILE
    delete process.env.KIMAKI_TEST_EXIT_FILE
    delete process.env.KIMAKI_TEST_PID_FILE
    store.setState({ opencodePort: null })
  })

  afterEach(async () => {
    await stopOpencodeServer()
    if (previousOpencode2Path === undefined) delete process.env.OPENCODE2_PATH
    else process.env.OPENCODE2_PATH = previousOpencode2Path
    if (previousOpencodePath === undefined) delete process.env.OPENCODE_PATH
    else process.env.OPENCODE_PATH = previousOpencodePath
    delete process.env.KIMAKI_TEST_RELEASE_FILE
    delete process.env.KIMAKI_TEST_EXIT_FILE
    delete process.env.KIMAKI_TEST_PID_FILE
    delete process.env['KIMAKI_LOCK_PORT']
    store.setState({ opencodePort: null })
    for (const directory of fakeDirs) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
    fakeDirs.length = 0
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true })
  })

  test('stopOpencodeServer does not restart a child that exits 130 with signal null', async () => {
    const fake = writeFakeOpencode({ contents: EXIT_130_JS, fileName: 'fake-opencode.mjs' })
    fakeDirs.push(fake.directory)
    process.env.OPENCODE2_PATH = fake.filePath
    process.env.OPENCODE_PATH = fake.filePath

    const projectDirectory = path.join(sandbox, 'project')
    fs.mkdirSync(projectDirectory, { recursive: true })

    const lifecycle: Array<'started' | 'stopped'> = []
    const unsubscribe = subscribeOpencodeServerLifecycle((event) => {
      lifecycle.push(event.type)
    })

    const client = await initializeOpencodeForDirectory(projectDirectory)
    if (client instanceof Error) throw client
    expect(getOpencodeServerPort()).toEqual(expect.any(Number))

    const stopped = await stopOpencodeServer()
    expect(stopped).toBe(true)
    unsubscribe()

    expect(lifecycle).toEqual(['started', 'stopped'])
    expect(getOpencodeServerPort()).toBeNull()
  })

  test('stopOpencodeServer resolves when the child exits', async () => {
    const fake = writeFakeOpencode({ contents: EXIT_130_JS, fileName: 'fake-opencode.mjs' })
    fakeDirs.push(fake.directory)
    process.env.OPENCODE2_PATH = fake.filePath
    process.env.OPENCODE_PATH = fake.filePath
    const exitFile = path.join(sandbox, 'child-exited')
    process.env.KIMAKI_TEST_EXIT_FILE = exitFile

    const projectDirectory = path.join(sandbox, 'project')
    fs.mkdirSync(projectDirectory, { recursive: true })
    const client = await initializeOpencodeForDirectory(projectDirectory)
    if (client instanceof Error) throw client

    const startedAt = performance.now()
    expect(await stopOpencodeServer()).toBe(true)
    const elapsedMs = performance.now() - startedAt

    expect(fs.existsSync(exitFile)).toBe(true)
    expect(elapsedMs).toBeLessThan(500)
  })

  test('force-stops a child that does not exit after SIGTERM', async () => {
    const fake = writeFakeOpencode({ contents: EXIT_130_JS, fileName: 'fake-opencode.mjs' })
    fakeDirs.push(fake.directory)
    process.env.OPENCODE2_PATH = fake.filePath
    process.env.OPENCODE_PATH = fake.filePath
    const releaseFile = path.join(sandbox, 'release-old-child')
    process.env.KIMAKI_TEST_RELEASE_FILE = releaseFile

    const projectDirectory = path.join(sandbox, 'project')
    fs.mkdirSync(projectDirectory, { recursive: true })
    const firstClient = await initializeOpencodeForDirectory(projectDirectory)
    if (firstClient instanceof Error) throw firstClient
    expect(getOpencodeServerPort()).toEqual(expect.any(Number))

    const startedAt = performance.now()
    expect(await stopOpencodeServer()).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(1_500)
    expect(getOpencodeServerPort()).toBeNull()
  })

  test('waitForServer fails on the next poll when the child exits before ready', async () => {
    const fake = writeFakeOpencode({ contents: CRASH_JS, fileName: 'fake-opencode-crash.mjs' })
    fakeDirs.push(fake.directory)
    const port = await listenOnEphemeralPort()
    const startupStderrTail: string[] = []
    const child = spawn(process.execPath, [fake.filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const trimmed = line.trim()
        if (trimmed) startupStderrTail.push(trimmed)
      }
    })

    const startedAt = Date.now()
    const result = await waitForServer({
      port,
      password: 'unused',
      maxAttempts: 300,
      startupStderrTail,
      child,
    })
    const elapsedMs = Date.now() - startedAt

    expect(result).toBeInstanceOf(ServerStartError)
    if (!(result instanceof ServerStartError)) return
    expect(elapsedMs).toBeLessThan(2_000)
    expect(result.message).toContain('exited with code 1')
    expect(result.message).toContain('fake opencode: bind failed on purpose')
  })

  test('initialize during stop waits for the old child and never returns it', async () => {
    const fake = writeFakeOpencode({ contents: EXIT_130_JS, fileName: 'fake-opencode.mjs' })
    fakeDirs.push(fake.directory)
    process.env.OPENCODE2_PATH = fake.filePath
    process.env.OPENCODE_PATH = fake.filePath
    const releaseFile = path.join(sandbox, 'release-old-child')
    const exitFile = path.join(sandbox, 'child-exited')
    process.env.KIMAKI_TEST_RELEASE_FILE = releaseFile
    process.env.KIMAKI_TEST_EXIT_FILE = exitFile

    const projectDirectory = path.join(sandbox, 'project')
    fs.mkdirSync(projectDirectory, { recursive: true })
    const firstClient = await initializeOpencodeForDirectory(projectDirectory)
    if (firstClient instanceof Error) throw firstClient
    const originalPort = getOpencodeServerPort()
    expect(originalPort).toEqual(expect.any(Number))

    const stopping = stopOpencodeServer()
    const replacing = initializeOpencodeForDirectory(projectDirectory)
    expect(fs.existsSync(exitFile)).toBe(false)
    fs.writeFileSync(releaseFile, 'release')

    const [stopped, replacement] = await Promise.all([stopping, replacing])
    if (replacement instanceof Error) throw replacement

    expect(stopped).toBe(true)
    expect(fs.existsSync(exitFile)).toBe(true)
    expect(getOpencodeServerPort()).toEqual(expect.any(Number))
    expect(getOpencodeServerPort()).not.toBe(originalPort)
  })

  test('stop during startup kills the starting child including SIGKILL', async () => {
    const fake = writeFakeOpencode({
      contents: HANG_BEFORE_LISTEN_JS,
      fileName: 'fake-opencode-hang.mjs',
    })
    fakeDirs.push(fake.directory)
    process.env.OPENCODE2_PATH = fake.filePath
    process.env.OPENCODE_PATH = fake.filePath
    const pidFile = path.join(sandbox, 'starting.pid')
    const releaseFile = path.join(sandbox, 'release-starting-child')
    process.env.KIMAKI_TEST_PID_FILE = pidFile
    process.env.KIMAKI_TEST_RELEASE_FILE = releaseFile

    const projectDirectory = path.join(sandbox, 'project')
    fs.mkdirSync(projectDirectory, { recursive: true })
    const starting = initializeOpencodeForDirectory(projectDirectory)
    await waitForFile(pidFile)
    const startingPid = Number(fs.readFileSync(pidFile, 'utf8'))
    expect(Number.isInteger(startingPid)).toBe(true)
    expect(isPidAlive(startingPid)).toBe(true)

    const startedAt = performance.now()
    const stopped = await stopOpencodeServer()
    expect(stopped).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(1_500)
    expect(isPidAlive(startingPid)).toBe(false)
    expect(getOpencodeServerPort()).toBeNull()

    const startResult = await starting
    expect(startResult).toBeInstanceOf(ServerStartError)
  })

  test('fixed-port replacement starts only after the old child exits', async () => {
    const fake = writeFakeOpencode({ contents: EXIT_130_JS, fileName: 'fake-opencode.mjs' })
    fakeDirs.push(fake.directory)
    process.env.OPENCODE2_PATH = fake.filePath
    process.env.OPENCODE_PATH = fake.filePath
    const releaseFile = path.join(sandbox, 'release-fixed-port-child')
    const exitFile = path.join(sandbox, 'fixed-port-exited')
    process.env.KIMAKI_TEST_RELEASE_FILE = releaseFile
    process.env.KIMAKI_TEST_EXIT_FILE = exitFile

    const projectDirectory = path.join(sandbox, 'project')
    fs.mkdirSync(projectDirectory, { recursive: true })
    const firstClient = await initializeOpencodeForDirectory(projectDirectory)
    if (firstClient instanceof Error) throw firstClient
    const port = getOpencodeServerPort()
    expect(port).toEqual(expect.any(Number))
    store.setState({ opencodePort: port })

    const stopping = stopOpencodeServer()
    const replacing = initializeOpencodeForDirectory(projectDirectory)
    expect(fs.existsSync(exitFile)).toBe(false)
    fs.writeFileSync(releaseFile, 'release')

    const [stopped, replacement] = await Promise.all([stopping, replacing])
    if (replacement instanceof Error) throw replacement

    expect(stopped).toBe(true)
    expect(fs.existsSync(exitFile)).toBe(true)
    expect(getOpencodeServerPort()).toBe(port)
  })
})
