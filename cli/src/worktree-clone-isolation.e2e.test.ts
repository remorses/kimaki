// Verifies OpenCode workspace creation stays bound to the requested local clone.

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { setDataDir } from './config.js'
import { initializeOpencodeForDirectory, stopOpencodeServer } from './opencode.js'
import { chooseLockPort } from './test-utils.js'
import { execAsync } from './worktrees.js'
import { KIMAKI_WORKTREE_ADAPTER_TYPE } from './git-worktree-core.js'

const WORKTREE_BRANCH = 'opencode/kimaki-clone-isolation'

async function git({ cwd, args }: { cwd: string; args: string[] }) {
  const result = await execAsync(`git ${args.map((arg) => JSON.stringify(arg)).join(' ')}`, {
    cwd,
    timeout: 60_000,
  })
  return result.stdout.trim()
}

let sandbox = ''
let requestedClone = ''
let otherClone = ''

beforeAll(async () => {
  const root = path.resolve(process.cwd(), 'tmp')
  fs.mkdirSync(root, { recursive: true })
  sandbox = fs.mkdtempSync(path.join(root, 'worktree-clone-isolation-'))
  const remote = path.join(sandbox, 'remote.git')
  requestedClone = path.join(sandbox, 'holocron')
  otherClone = path.join(sandbox, 'fumabase')

  process.env['KIMAKI_LOCK_PORT'] = String(chooseLockPort({ key: 'worktree-clone-isolation' }))
  setDataDir(path.join(sandbox, 'data'))

  await git({ cwd: sandbox, args: ['init', '--bare', '-b', 'main', remote] })
  await git({ cwd: sandbox, args: ['clone', remote, otherClone] })
  await git({
    cwd: otherClone,
    args: ['config', 'user.email', 'kimaki-tests@example.com'],
  })
  await git({ cwd: otherClone, args: ['config', 'user.name', 'Kimaki Tests'] })
  fs.writeFileSync(path.join(otherClone, 'preview.txt'), 'old preview\n')
  await git({ cwd: otherClone, args: ['add', 'preview.txt'] })
  await git({ cwd: otherClone, args: ['commit', '-m', 'old preview'] })
  await git({ cwd: otherClone, args: ['push', 'origin', 'HEAD:main'] })
  await git({ cwd: otherClone, args: ['switch', '-c', 'preview'] })

  await git({ cwd: sandbox, args: ['clone', remote, requestedClone] })
  await git({
    cwd: requestedClone,
    args: ['config', 'user.email', 'kimaki-tests@example.com'],
  })
  await git({ cwd: requestedClone, args: ['config', 'user.name', 'Kimaki Tests'] })
  fs.mkdirSync(path.join(requestedClone, 'vite'))
  fs.writeFileSync(path.join(requestedClone, 'vite', 'README.md'), 'new layout\n')
  await git({ cwd: requestedClone, args: ['add', 'vite/README.md'] })
  await git({ cwd: requestedClone, args: ['commit', '-m', 'add vite layout'] })
}, 20_000)

afterAll(async () => {
  await stopOpencodeServer()
  delete process.env['KIMAKI_LOCK_PORT']
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true })
})

test('creates a workspace from the exact requested clone and commit', async () => {
  const requestedCommit = await git({
    cwd: requestedClone,
    args: ['rev-parse', 'HEAD^{commit}'],
  })
  const requestedCommonDirectory = path.resolve(
    requestedClone,
    await git({
      cwd: requestedClone,
      args: ['rev-parse', '--git-common-dir'],
    }),
  )

  const requestedClientResult = await initializeOpencodeForDirectory(requestedClone)
  if (requestedClientResult instanceof Error) throw requestedClientResult
  const otherClientResult = await initializeOpencodeForDirectory(otherClone)
  if (otherClientResult instanceof Error) throw otherClientResult
  const requestedClient = requestedClientResult()
  const otherClient = otherClientResult()

  // Load the requested clone first, then overwrite the colliding OpenCode
  // project adapter with the other clone before creating the workspace.
  await requestedClient.config.get({ directory: requestedClone })
  await otherClient.config.get({ directory: otherClone })

  const response = await requestedClient.experimental.workspace.create({
    directory: requestedClone,
    type: KIMAKI_WORKTREE_ADAPTER_TYPE,
    branch: WORKTREE_BRANCH,
    extra: {
      projectDirectory: requestedClone,
      baseCommit: requestedCommit,
      expectedCommonGitDirectory: requestedCommonDirectory,
    },
  })
  if (response.error) throw new Error(JSON.stringify(response.error))
  const workspace = response.data
  if (!workspace) throw new Error('OpenCode returned no workspace')

  try {
    const actualCommit = await git({
      cwd: workspace.directory!,
      args: ['rev-parse', 'HEAD^{commit}'],
    })
    const actualCommonDirectory = path.resolve(
      workspace.directory!,
      await git({
        cwd: workspace.directory!,
        args: ['rev-parse', '--git-common-dir'],
      }),
    )

    expect({
      usesRequestedClone:
        path.resolve(actualCommonDirectory) === path.resolve(requestedCommonDirectory),
      usesRequestedCommit: actualCommit === requestedCommit,
      hasRequestedLayout: fs.existsSync(path.join(workspace.directory!, 'vite', 'README.md')),
      absentFromOtherClone: !(
        await git({
          cwd: otherClone,
          args: ['worktree', 'list', '--porcelain'],
        })
      ).includes(workspace.directory!),
    }).toMatchInlineSnapshot(`
        {
          "absentFromOtherClone": true,
          "hasRequestedLayout": true,
          "usesRequestedClone": true,
          "usesRequestedCommit": true,
        }
      `)
  } finally {
    await requestedClient.experimental.workspace.remove({
      id: workspace.id,
      directory: requestedClone,
    })
  }
}, 30_000)
