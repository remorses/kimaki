import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { createWorktree, deleteWorktree, git, listWorktrees, mergeWorktree, resolveWorkingDirectory } from './worktrees.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

async function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-worktrees-')))
  roots.push(root)
  const directory = path.join(root, 'project')
  fs.mkdirSync(directory)
  await checked(directory, ['init', '-q', '-b', 'main'])
  await checked(directory, ['config', 'user.name', 'Test'])
  await checked(directory, ['config', 'user.email', 'test@example.com'])
  fs.writeFileSync(path.join(directory, 'file.txt'), 'original\n')
  await checked(directory, ['add', '.'])
  await checked(directory, ['commit', '-qm', 'initial'])
  return { root, directory }
}

async function checked(directory: string, args: string[]) {
  const result = await git({ directory, args })
  if (result instanceof Error) throw result
  return result
}

test('custom worktrees use the exact clone and committed HEAD; cwd resolves subfolders and symlinks safely', async () => {
  const { root, directory } = await repo()
  fs.writeFileSync(path.join(directory, 'file.txt'), 'uncommitted\n')
  const created = await createWorktree({ projectDirectory: directory, dataDir: root, name: 'feature' })
  if (created instanceof Error) throw created
  fs.mkdirSync(path.join(created.directory, 'src'))
  const alias = path.join(root, 'alias')
  fs.symlinkSync(created.directory, alias)
  const resolved = await resolveWorkingDirectory({ projectDirectory: directory, candidate: path.join(alias, 'src') })
  expect(resolved).toBe(path.join(created.directory, 'src'))
  expect(fs.readFileSync(path.join(created.directory, 'file.txt'), 'utf8')).toBe('original\n')
  expect(created.branch).toBe('opencode/kimaki-feature')
  expect(await createWorktree({ projectDirectory: directory, dataDir: root, name: '../escape' })).toBeInstanceOf(Error)
  expect(await createWorktree({ projectDirectory: directory, dataDir: root, name: 'feature' })).toBeInstanceOf(Error)
  const clone = path.join(root, 'clone')
  await checked(root, ['clone', '-q', directory, clone])
  expect(await resolveWorkingDirectory({ projectDirectory: directory, candidate: clone })).toBeInstanceOf(Error)
  const cloneTree = await createWorktree({ projectDirectory: clone, dataDir: root, name: 'feature' })
  if (cloneTree instanceof Error) throw cloneTree
  expect(cloneTree.directory).not.toBe(created.directory)
  const listed = await listWorktrees({ projectDirectory: directory })
  if (listed instanceof Error) throw listed
  expect(listed.map((tree) => tree.directory)).toEqual([created.directory])
})

test.each(['rebase', 'squash'] as const)('%s merges locally and deletion rejects dirty and unmerged work', async (strategy) => {
  const { root, directory } = await repo()
  const created = await createWorktree({ projectDirectory: directory, dataDir: root, name: strategy })
  if (created instanceof Error) throw created
  fs.writeFileSync(path.join(created.directory, 'feature.txt'), 'feature\n')
  expect(await deleteWorktree({ projectDirectory: directory, directory: created.directory })).toBeInstanceOf(Error)
  await checked(created.directory, ['add', '.'])
  await checked(created.directory, ['commit', '-qm', 'feature'])
  expect(await deleteWorktree({ projectDirectory: directory, directory: created.directory })).toBeInstanceOf(Error)
  fs.writeFileSync(path.join(created.directory, 'second.txt'), 'second\n')
  await checked(created.directory, ['add', '.'])
  await checked(created.directory, ['commit', '-qm', 'second feature'])
  fs.writeFileSync(path.join(directory, 'file.txt'), 'dirty target\n')
  expect(await mergeWorktree({ projectDirectory: directory, directory: created.directory, strategy })).toBeInstanceOf(Error)
  fs.writeFileSync(path.join(directory, 'file.txt'), 'original\n')
  fs.writeFileSync(path.join(directory, 'target.txt'), 'target\n')
  await checked(directory, ['add', '.'])
  await checked(directory, ['commit', '-qm', 'target advanced'])
  const merged = await mergeWorktree({ projectDirectory: directory, directory: created.directory, strategy })
  if (merged instanceof Error) throw merged
  expect(fs.readFileSync(path.join(directory, 'feature.txt'), 'utf8')).toBe('feature\n')
  expect(await checked(directory, ['rev-list', '--count', 'main'])).toBe(strategy === 'rebase' ? '4' : '3')
  expect(await checked(created.directory, ['branch', '--show-current'])).toBe('')
  expect(await deleteWorktree({ projectDirectory: directory, directory: created.directory })).toBeUndefined()
  expect(await deleteWorktree({ projectDirectory: directory, directory })).toBeInstanceOf(Error)
})

test('merge conflicts leave the worktree paused and a retry does not hide the rebase', async () => {
  const { root, directory } = await repo()
  const created = await createWorktree({ projectDirectory: directory, dataDir: root, name: 'conflict' })
  if (created instanceof Error) throw created
  fs.writeFileSync(path.join(created.directory, 'file.txt'), 'source\n')
  await checked(created.directory, ['commit', '-am', 'source changed'])
  fs.writeFileSync(path.join(directory, 'file.txt'), 'target\n')
  await checked(directory, ['commit', '-am', 'target changed'])
  const result = await mergeWorktree({ projectDirectory: directory, directory: created.directory })
  if (!(result instanceof Error)) throw new Error('Expected a conflict')
  expect(result.message.replaceAll(created.directory, 'WORKTREE')).toMatchInlineSnapshot(`"Rebase failed in WORKTREE. Resolve conflicts and run git rebase --continue, then retry the merge."`)
  const retry = await mergeWorktree({ projectDirectory: directory, directory: created.directory })
  if (!(retry instanceof Error)) throw new Error('Expected a paused rebase')
  expect(retry.message).toMatchInlineSnapshot(`"A rebase is already paused. Resolve conflicts and run git rebase --continue, or git rebase --abort, before merging."`)
  expect(fs.readFileSync(path.join(directory, 'file.txt'), 'utf8')).toBe('target\n')
  expect(fs.readFileSync(path.join(created.directory, 'file.txt'), 'utf8')).toContain('<<<<<<<')
})
