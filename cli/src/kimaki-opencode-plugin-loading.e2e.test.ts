// E2e: OpenCode v2 loads the Kimaki plugin directory without errors.
// v2 plugins are directories, not .ts files. Subrouter v1 provider tests live
// elsewhere; this file only checks opencode2 serve + the kimaki plugin dir.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { buildBasicAuthHeader, startOpencode2Server, type Opencode2Server } from './opencode2.js'

const pluginDirectory = path.join(import.meta.dirname, '../dist/kimaki-opencode-plugin')

const stderrLines: string[] = []
let server: Opencode2Server | undefined
let tempDir = ''

beforeAll(async () => {
  expect(fs.existsSync(path.join(pluginDirectory, 'index.js'))).toBe(true)
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-plugin-loading-')))
  fs.writeFileSync(
    path.join(tempDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        plugins: [pluginDirectory],
      },
      null,
      2,
    ),
  )

  const started = await startOpencode2Server()
  if (started instanceof Error) {
    throw started
  }
  server = started
  server.process.stderr?.on('data', (chunk) => {
    stderrLines.push(...chunk.toString().split('\n').filter(Boolean))
  })

  const health = await fetch(`${server.baseUrl}/api/session/active`, {
    headers: { authorization: buildBasicAuthHeader({ password: server.password }) },
  })
  expect(health.status).toBe(200)
}, 120_000)

afterAll(() => {
  server?.close()
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('server loads the kimaki plugin directory without errors', () => {
  const pluginErrorPatterns = [
    /plugin.*error/i,
    /failed to load plugin/i,
    /cannot find module/i,
    /ERR_MODULE_NOT_FOUND/i,
    /plugin.*failed/i,
    /plugin.*crash/i,
  ]
  const errorLines = stderrLines.filter((line) => {
    return pluginErrorPatterns.some((pattern) => {
      return pattern.test(line)
    })
  })
  expect(errorLines).toEqual([])
})
