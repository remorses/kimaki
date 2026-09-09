// Tests that `kimaki project add` refuses a folder already registered locally.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setDataDir } from './config.js'
import { closeDb } from './db.js'
import {
  findRegisteredTextChannelForDirectory,
  formatProjectAlreadyRegisteredError,
  initDatabase,
  setChannelDirectory,
} from './database.js'

describe('project add duplicate directory', () => {
  let tmpDir: string
  let projectDir: string

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-project-add-'))
    projectDir = path.join(tmpDir, 'repo')
    fs.mkdirSync(projectDir)
    setDataDir(path.join(tmpDir, 'data'))
    await closeDb()
    await initDatabase()
  })

  afterEach(async () => {
    await closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('returns the existing text channel for a registered folder', async () => {
    await setChannelDirectory({
      channelId: '111',
      directory: projectDir,
      channelType: 'text',
    })

    const existing = await findRegisteredTextChannelForDirectory(projectDir)
    expect(existing).toMatchObject({
      channel_id: '111',
      directory: projectDir,
      channel_type: 'text',
    })
  })

  test('matches a symlink to the same registered folder', async () => {
    await setChannelDirectory({
      channelId: '222',
      directory: fs.realpathSync(projectDir),
      channelType: 'text',
    })

    const alias = path.join(tmpDir, 'alias')
    fs.symlinkSync(projectDir, alias)

    const existing = await findRegisteredTextChannelForDirectory(alias)
    expect(existing?.channel_id).toBe('222')
  })

  test('returns null when the folder is not registered', async () => {
    const existing = await findRegisteredTextChannelForDirectory(projectDir)
    expect(existing).toBe(null)
  })

  test('error message tells the user how to remove the mapping', () => {
    expect(
      formatProjectAlreadyRegisteredError({
        channelId: '111',
        directory: '/tmp/repo',
      }),
    ).toMatchInlineSnapshot(`
      "Channel already exists for this directory: /tmp/repo
      Channel ID: 111
      Remove the mapping first: kimaki project remove 111"
    `)
  })
})
