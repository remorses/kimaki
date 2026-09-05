// Tests for file-edit event extraction, derivation, and JSONL persistence.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  appendFileEditEvents,
  createFileEditHooks,
  editorsForFile,
  extractEditedFiles,
  loadFileEditEvents,
  type FileEditEvent,
} from './file-edit-log.js'

const tempDirs: string[] = []

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-file-edit-log-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function event(partial: Partial<FileEditEvent> & Pick<FileEditEvent, 'sessionId' | 'file'>): FileEditEvent {
  return {
    v: 1,
    at: 1,
    tool: 'edit',
    ...partial,
  }
}

describe('extractEditedFiles', () => {
  test('extracts edit and write filePath and ignores other tools', () => {
    expect(
      extractEditedFiles({
        tool: 'edit',
        args: { filePath: 'src/foo.ts' },
        directory: '/repo',
      }),
    ).toMatchInlineSnapshot(`
      [
        "/repo/src/foo.ts",
      ]
    `)
    expect(
      extractEditedFiles({
        tool: 'write',
        args: { filePath: '/abs/bar.ts' },
        directory: '/repo',
      }),
    ).toMatchInlineSnapshot(`
      [
        "/abs/bar.ts",
      ]
    `)
    expect(
      extractEditedFiles({
        tool: 'read',
        args: { filePath: 'src/foo.ts' },
        directory: '/repo',
      }),
    ).toMatchInlineSnapshot(`
      []
    `)
    expect(
      extractEditedFiles({
        tool: 'bash',
        args: {},
        directory: '/repo',
      }),
    ).toMatchInlineSnapshot(`
      []
    `)
  })

  test('extracts apply_patch paths and resolves them against directory', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Update File: src/foo.ts',
      '@@',
      '-a',
      '+b',
      '*** Add File: src/bar.ts',
      '+hello',
      '*** Delete File: src/old.ts',
      '*** Move to: src/renamed.ts',
      '*** End Patch',
    ].join('\n')

    expect(
      extractEditedFiles({
        tool: 'apply_patch',
        args: { patchText },
        directory: '/repo',
      }),
    ).toMatchInlineSnapshot(`
      [
        "/repo/src/foo.ts",
        "/repo/src/bar.ts",
        "/repo/src/old.ts",
        "/repo/src/renamed.ts",
      ]
    `)
  })
})

describe('editorsForFile', () => {
  test('orders unique sessions by last edit and matches relative paths', () => {
    const events: FileEditEvent[] = [
      event({ sessionId: 'ses_old', file: '/repo/src/foo.ts', at: 10 }),
      event({ sessionId: 'ses_other', file: '/repo/src/other.ts', at: 50 }),
      event({ sessionId: 'ses_new', file: '/repo/src/foo.ts', at: 20 }),
      event({ sessionId: 'ses_old', file: '/repo/src/foo.ts', at: 40, tool: 'write' }),
    ]

    expect(
      editorsForFile({
        events,
        filePath: 'src/foo.ts',
        cwd: '/repo',
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "at": 40,
          "sessionId": "ses_old",
        },
        {
          "at": 20,
          "sessionId": "ses_new",
        },
      ]
    `)
  })
})

describe('file edit jsonl log', () => {
  test('appends events and loads them back', () => {
    const dataDir = makeDataDir()
    const first: FileEditEvent[] = [
      event({ sessionId: 'ses_a', file: '/repo/a.ts', at: 1 }),
    ]
    const second: FileEditEvent[] = [
      event({ sessionId: 'ses_b', file: '/repo/b.ts', at: 2, tool: 'write' }),
    ]

    const appended = appendFileEditEvents({ dataDir, events: first })
    if (appended instanceof Error) throw appended
    const appendedAgain = appendFileEditEvents({ dataDir, events: second })
    if (appendedAgain instanceof Error) throw appendedAgain

    const loaded = loadFileEditEvents({ dataDir })
    if (loaded instanceof Error) throw loaded
    expect(loaded).toMatchInlineSnapshot(`
      [
        {
          "at": 1,
          "file": "/repo/a.ts",
          "sessionId": "ses_a",
          "tool": "edit",
          "v": 1,
        },
        {
          "at": 2,
          "file": "/repo/b.ts",
          "sessionId": "ses_b",
          "tool": "write",
          "v": 1,
        },
      ]
    `)
  })

  test('compacts to the newest events when the log is too large', () => {
    const dataDir = makeDataDir()
    const events: FileEditEvent[] = [
      event({ sessionId: 'ses_1', file: '/repo/a.ts', at: 1 }),
      event({ sessionId: 'ses_2', file: '/repo/b.ts', at: 2 }),
      event({ sessionId: 'ses_3', file: '/repo/c.ts', at: 3 }),
    ]
    const appended = appendFileEditEvents({
      dataDir,
      events,
      maxEvents: 2,
      compactAfterBytes: 1,
    })
    if (appended instanceof Error) throw appended

    const loaded = loadFileEditEvents({ dataDir })
    if (loaded instanceof Error) throw loaded
    expect(loaded).toMatchInlineSnapshot(`
      [
        {
          "at": 2,
          "file": "/repo/b.ts",
          "sessionId": "ses_2",
          "tool": "edit",
          "v": 1,
        },
        {
          "at": 3,
          "file": "/repo/c.ts",
          "sessionId": "ses_3",
          "tool": "edit",
          "v": 1,
        },
      ]
    `)
  })

  test('compacts repeated edits of the same session and file to one row', () => {
    const dataDir = makeDataDir()
    const events: FileEditEvent[] = [
      event({ sessionId: 'ses_a', file: '/repo/a.ts', at: 1 }),
      event({ sessionId: 'ses_a', file: '/repo/a.ts', at: 2, tool: 'write' }),
      event({ sessionId: 'ses_a', file: '/repo/a.ts', at: 3 }),
    ]
    const appended = appendFileEditEvents({
      dataDir,
      events,
      maxEvents: 10,
      compactAfterBytes: 1,
    })
    if (appended instanceof Error) throw appended

    const loaded = loadFileEditEvents({ dataDir })
    if (loaded instanceof Error) throw loaded
    expect(loaded).toMatchInlineSnapshot(`
      [
        {
          "at": 3,
          "file": "/repo/a.ts",
          "sessionId": "ses_a",
          "tool": "edit",
          "v": 1,
        },
      ]
    `)
  })
})

describe('fileEditTrackerPlugin', () => {
  test('records edit and apply_patch and ignores bash', async () => {
    const dataDir = makeDataDir()
    const hooks = createFileEditHooks({ dataDir, directory: '/repo' })
    await hooks['tool.execute.after']({
      tool: 'edit',
      sessionID: 'ses_x',
      args: { filePath: 'src/a.ts' },
    })
    await hooks['tool.execute.after']({
      tool: 'apply_patch',
      sessionID: 'ses_x',
      args: { patchText: '*** Update File: src/b.ts\n' },
    })
    await hooks['tool.execute.after']({
      tool: 'bash',
      sessionID: 'ses_x',
      args: {},
    })
    const loaded = loadFileEditEvents({ dataDir })
    if (loaded instanceof Error) throw loaded
    expect(loaded.map((entry) => {
      return { sessionId: entry.sessionId, file: entry.file, tool: entry.tool }
    })).toMatchInlineSnapshot(`
      [
        {
          "file": "/repo/src/a.ts",
          "sessionId": "ses_x",
          "tool": "edit",
        },
        {
          "file": "/repo/src/b.ts",
          "sessionId": "ses_x",
          "tool": "apply_patch",
        },
      ]
    `)
  })
})
