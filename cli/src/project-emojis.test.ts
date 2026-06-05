// Unit tests for the project emoji prefix map module.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from './config.js'

describe('project-emojis', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-emoji-test-'))
    setDataDir(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when no map file exists', async () => {
    const { getProjectEmoji } = await import('./project-emojis.js')
    expect(getProjectEmoji('myproject')).toBeNull()
  })

  it('persists and reads back the emoji for a project', async () => {
    const { setProjectEmoji, getProjectEmoji } = await import(
      './project-emojis.js'
    )
    setProjectEmoji('website', '🌐')
    expect(getProjectEmoji('/abs/path/to/website')).toBe('🌐')
    expect(getProjectEmoji('website')).toBe('🌐')
  })

  it('removes a project emoji', async () => {
    const { setProjectEmoji, removeProjectEmoji, getProjectEmoji } =
      await import('./project-emojis.js')
    setProjectEmoji('kimaki', '🔮')
    expect(getProjectEmoji('kimaki')).toBe('🔮')
    expect(removeProjectEmoji('kimaki')).toBe(true)
    expect(getProjectEmoji('kimaki')).toBeNull()
    expect(removeProjectEmoji('kimaki')).toBe(false)
  })

  it('lists all configured project emojis', async () => {
    const { setProjectEmoji, listProjectEmojis } = await import(
      './project-emojis.js'
    )
    setProjectEmoji('kimaki', '🔮')
    setProjectEmoji('website', '🌐')
    const list = listProjectEmojis()
    expect(list).toEqual({ kimaki: '🔮', website: '🌐' })
  })

  it('treats a corrupt map file as empty instead of throwing', async () => {
    fs.writeFileSync(path.join(tmpDir, 'project-emojis.json'), '{ not json')
    const { getProjectEmoji, listProjectEmojis } = await import(
      './project-emojis.js'
    )
    expect(getProjectEmoji('kimaki')).toBeNull()
    expect(listProjectEmojis()).toEqual({})
  })

  it('drops entries with non-string values or empty keys', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'project-emojis.json'),
      JSON.stringify({
        kimaki: '🔮',
        website: 42,
        '': '🫥',
        emptyValue: '',
      }),
    )
    const { listProjectEmojis } = await import('./project-emojis.js')
    expect(listProjectEmojis()).toEqual({ kimaki: '🔮' })
  })

  it('treats a non-object map file as empty', async () => {
    fs.writeFileSync(path.join(tmpDir, 'project-emojis.json'), '"a string"')
    const { getProjectEmoji } = await import('./project-emojis.js')
    expect(getProjectEmoji('kimaki')).toBeNull()
  })

  it('prefixes a thread name with the configured emoji', async () => {
    const { prefixNameWithEmoji } = await import('./project-emojis.js')
    expect(prefixNameWithEmoji('fix the bug', '🔮')).toBe('🔮 fix the bug')
  })

  it('does not double-prefix when name already starts with the emoji', async () => {
    const { prefixNameWithEmoji } = await import('./project-emojis.js')
    expect(prefixNameWithEmoji('🔮 fix the bug', '🔮')).toBe('🔮 fix the bug')
    expect(prefixNameWithEmoji('🔮-fix the bug', '🔮')).toBe('🔮-fix the bug')
  })

  it('returns the name unchanged when no emoji is given', async () => {
    const { prefixNameWithEmoji } = await import('./project-emojis.js')
    expect(prefixNameWithEmoji('fix the bug', null)).toBe('fix the bug')
  })

  it('projectEmojiForChannel returns the project emoji when channel is registered', async () => {
    const { setProjectEmoji, projectEmojiForChannel } = await import(
      './project-emojis.js'
    )
    const { initDatabase, setChannelDirectory, getDb } = await import(
      './database.js'
    )
    setProjectEmoji('website', '🌐')
    await initDatabase()
    await setChannelDirectory({
      channelId: 'channel-abc',
      directory: '/abs/path/to/website',
      channelType: 'text',
    })
    expect(await projectEmojiForChannel('channel-abc')).toBe('🌐')
    // getDb imported for the side effect of triggering the DB module
    void getDb
  })

  it('projectEmojiForChannel returns null when the channel is not registered', async () => {
    const { projectEmojiForChannel } = await import('./project-emojis.js')
    const { initDatabase } = await import('./database.js')
    await initDatabase()
    expect(await projectEmojiForChannel('does-not-exist')).toBeNull()
  })

  it('projectEmojiForChannel returns null when the project has no emoji', async () => {
    const { projectEmojiForChannel } = await import('./project-emojis.js')
    const { initDatabase, setChannelDirectory } = await import(
      './database.js'
    )
    await initDatabase()
    await setChannelDirectory({
      channelId: 'channel-no-emoji',
      directory: '/abs/path/to/uncharted',
      channelType: 'text',
    })
    expect(await projectEmojiForChannel('channel-no-emoji')).toBeNull()
  })
})
