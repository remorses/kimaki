// Tests for reusable worktree and submodule initialization helpers.
// Uses temporary local git repositories to validate submodule behavior end to end.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildSubmoduleReferencePlan,
  createWorktreeWithSubmodules,
  execAsync,
  parseGitmodulesFileContent,
} from './worktrees.js'

const GIT_TIMEOUT_MS = 60_000

function gitCommand(args: string[]): string {
  return `git ${args
    .map((arg) => {
      return JSON.stringify(arg)
    })
    .join(' ')}`
}

async function git({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}): Promise<string> {
  const result = await execAsync(gitCommand(args), {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  })
  return result.stdout.trim()
}

function createTestRoot(): string {
  const tmpRoot = path.resolve(process.cwd(), 'tmp')
  fs.mkdirSync(tmpRoot, { recursive: true })
  return fs.mkdtempSync(path.join(tmpRoot, 'worktrees-test-'))
}

describe('worktrees', () => {
  test('parseGitmodulesFileContent parses paths and urls', () => {
    const parsed = parseGitmodulesFileContent(`
[submodule "errore"]
  path = errore
  url = https://github.com/remorses/errore.git
[submodule "gateway-proxy"]
  path = gateway-proxy
  url = https://github.com/remorses/gateway-proxy.git
`)

    expect(parsed).toMatchInlineSnapshot(`
      [
        {
          "name": "errore",
          "path": "errore",
          "url": "https://github.com/remorses/errore.git",
        },
        {
          "name": "gateway-proxy",
          "path": "gateway-proxy",
          "url": "https://github.com/remorses/gateway-proxy.git",
        },
      ]
    `)
  })

  test('buildSubmoduleReferencePlan uses local references when available', () => {
    const sourceDirectory = '/repo'
    const plan = buildSubmoduleReferencePlan({
      sourceDirectory,
      submodulePaths: ['errore', 'gateway-proxy', 'traforo'],
      existingSourceSubmoduleDirectories: new Set([
        '/repo/errore',
        '/repo/gateway-proxy',
      ]),
    })

    expect(plan).toMatchInlineSnapshot(`
      [
        {
          "path": "errore",
          "referenceDirectory": "/repo/errore",
        },
        {
          "path": "gateway-proxy",
          "referenceDirectory": "/repo/gateway-proxy",
        },
        {
          "path": "traforo",
          "referenceDirectory": null,
        },
      ]
    `)
  })

  test('createWorktreeWithSubmodules resolves local-only submodule commits from local source checkout', async () => {
    const sandbox = createTestRoot()
    const submoduleRemote = path.join(sandbox, 'errore-remote.git')
    const submoduleLocal = path.join(sandbox, 'errore-local')
    const parentRepo = path.join(sandbox, 'parent')
    const worktreeName = `opencode/kimaki-local-submodule-${Date.now()}`

    let createdWorktreeDirectory = ''

    try {
      fs.mkdirSync(parentRepo, { recursive: true })

      await git({ cwd: sandbox, args: ['init', '--bare', '-b', 'main', submoduleRemote] })
      await git({ cwd: sandbox, args: ['clone', submoduleRemote, submoduleLocal] })

      await git({
        cwd: submoduleLocal,
        args: ['config', 'user.email', 'kimaki-tests@example.com'],
      })
      await git({
        cwd: submoduleLocal,
        args: ['config', 'user.name', 'Kimaki Tests'],
      })

      fs.writeFileSync(path.join(submoduleLocal, 'README.md'), 'v1\n', 'utf-8')
      await git({ cwd: submoduleLocal, args: ['add', 'README.md'] })
      await git({ cwd: submoduleLocal, args: ['commit', '-m', 'v1'] })
      await git({ cwd: submoduleLocal, args: ['push', 'origin', 'HEAD:main'] })

      await git({ cwd: parentRepo, args: ['init', '-b', 'main'] })
      await git({
        cwd: parentRepo,
        args: ['config', 'user.email', 'kimaki-tests@example.com'],
      })
      await git({
        cwd: parentRepo,
        args: ['config', 'user.name', 'Kimaki Tests'],
      })
      await git({
        cwd: parentRepo,
        args: ['config', 'protocol.file.allow', 'always'],
      })

      fs.writeFileSync(path.join(parentRepo, 'README.md'), 'parent\n', 'utf-8')
      await git({ cwd: parentRepo, args: ['add', 'README.md'] })
      await git({ cwd: parentRepo, args: ['commit', '-m', 'init parent'] })

      await git({
        cwd: parentRepo,
        args: [
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          submoduleRemote,
          'errore',
        ],
      })
      await git({ cwd: parentRepo, args: ['commit', '-am', 'add submodule at v1'] })

      fs.writeFileSync(path.join(submoduleLocal, 'README.md'), 'v2-local-only\n', 'utf-8')
      await git({ cwd: submoduleLocal, args: ['add', 'README.md'] })
      await git({ cwd: submoduleLocal, args: ['commit', '-m', 'v2 local only'] })
      const localOnlySha = await git({
        cwd: submoduleLocal,
        args: ['rev-parse', 'HEAD'],
      })

      await git({
        cwd: path.join(parentRepo, 'errore'),
        args: ['fetch', submoduleLocal, localOnlySha],
      })
      await git({
        cwd: path.join(parentRepo, 'errore'),
        args: ['checkout', localOnlySha],
      })
      await git({
        cwd: parentRepo,
        args: ['add', 'errore'],
      })
      await git({
        cwd: parentRepo,
        args: ['commit', '-m', 'pin local-only submodule commit'],
      })

      const worktreeResult = await createWorktreeWithSubmodules({
        directory: parentRepo,
        name: worktreeName,
      })

      if (worktreeResult instanceof Error) {
        throw worktreeResult
      }

      createdWorktreeDirectory = worktreeResult.directory
      const worktreeSubmoduleSha = await git({
        cwd: path.join(worktreeResult.directory, 'errore'),
        args: ['rev-parse', 'HEAD'],
      })

      expect({
        localOnlyShaLength: localOnlySha.length,
        worktreeSubmoduleShaLength: worktreeSubmoduleSha.length,
        sameCommit: localOnlySha === worktreeSubmoduleSha,
      }).toMatchInlineSnapshot(`
        {
          "localOnlyShaLength": 40,
          "sameCommit": true,
          "worktreeSubmoduleShaLength": 40,
        }
      `)
    } finally {
      if (createdWorktreeDirectory) {
        await git({
          cwd: parentRepo,
          args: ['worktree', 'remove', '--force', createdWorktreeDirectory],
        }).catch(() => {
          return ''
        })
      }
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

})
