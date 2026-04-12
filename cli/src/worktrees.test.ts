// Tests for reusable worktree and submodule initialization helpers.
// Uses temporary local git repositories to validate submodule behavior end to end.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildSubmoduleReferencePlan,
  createWorktreeWithSubmodules,
  execAsync,
  getManagedWorktreeDirectory,
  parseGitmodulesFileContent,
  parseGitWorktreeListPorcelain,
} from './worktrees.js'
import {
  formatAutoWorktreeName,
  formatWorktreeName,
  shortenWorktreeSlug,
} from './commands/new-worktree.js'
import { setDataDir } from './config.js'

const GIT_TIMEOUT_MS = 60_000

async function git({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}): Promise<string> {
  const command = `git ${args
    .map((arg) => {
      return JSON.stringify(arg)
    })
    .join(' ')}`

  const result = await execAsync(command, {
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

  test('createWorktreeWithSubmodules uses current HEAD even when origin does not have the commit', async () => {
    const sandbox = createTestRoot()
    const parentRemote = path.join(sandbox, 'parent-remote.git')
    const parentLocal = path.join(sandbox, 'parent-local')
    const worktreeName = `opencode/kimaki-local-head-${Date.now()}`

    let createdWorktreeDirectory = ''

    try {
      await git({ cwd: sandbox, args: ['init', '--bare', '-b', 'main', parentRemote] })
      await git({ cwd: sandbox, args: ['clone', parentRemote, parentLocal] })

      await git({
        cwd: parentLocal,
        args: ['config', 'user.email', 'kimaki-tests@example.com'],
      })
      await git({
        cwd: parentLocal,
        args: ['config', 'user.name', 'Kimaki Tests'],
      })

      fs.writeFileSync(path.join(parentLocal, 'README.md'), 'v1\n', 'utf-8')
      await git({ cwd: parentLocal, args: ['add', 'README.md'] })
      await git({ cwd: parentLocal, args: ['commit', '-m', 'v1'] })
      await git({ cwd: parentLocal, args: ['push', 'origin', 'HEAD:main'] })

      fs.writeFileSync(path.join(parentLocal, 'README.md'), 'v2-local-only\n', 'utf-8')
      await git({ cwd: parentLocal, args: ['commit', '-am', 'v2 local only'] })

      const localHeadSha = await git({
        cwd: parentLocal,
        args: ['rev-parse', 'HEAD'],
      })
      const originHeadSha = await git({
        cwd: parentLocal,
        args: ['rev-parse', 'origin/main'],
      })

      const worktreeResult = await createWorktreeWithSubmodules({
        directory: parentLocal,
        name: worktreeName,
      })

      if (worktreeResult instanceof Error) {
        throw worktreeResult
      }

      createdWorktreeDirectory = worktreeResult.directory
      const worktreeHeadSha = await git({
        cwd: createdWorktreeDirectory,
        args: ['rev-parse', 'HEAD'],
      })

      expect({
        localHeadShaLength: localHeadSha.length,
        originHeadShaLength: originHeadSha.length,
        worktreeHeadShaLength: worktreeHeadSha.length,
        usesLocalOnlyHead: localHeadSha === worktreeHeadSha,
        differsFromOrigin: localHeadSha !== originHeadSha,
      }).toMatchInlineSnapshot(`
        {
          "differsFromOrigin": true,
          "localHeadShaLength": 40,
          "originHeadShaLength": 40,
          "usesLocalOnlyHead": true,
          "worktreeHeadShaLength": 40,
        }
      `)
    } finally {
      if (createdWorktreeDirectory) {
        await git({
          cwd: parentLocal,
          args: ['worktree', 'remove', '--force', createdWorktreeDirectory],
        }).catch(() => {
          return ''
        })
      }
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('shortenWorktreeSlug leaves short slugs alone', () => {
    expect(shortenWorktreeSlug('short-name')).toMatchInlineSnapshot(
      `"short-name"`,
    )
    expect(shortenWorktreeSlug('exactly-twenty-chars')).toMatchInlineSnapshot(
      `"exactly-twenty-chars"`,
    )
  })

  test('shortenWorktreeSlug strips vowels from long slugs', () => {
    expect(
      shortenWorktreeSlug('configurable-sidebar-width-by-component'),
    ).toMatchInlineSnapshot(`"cnfgrbl-sdbr-wdth-by-cmpnnt"`)
    expect(
      shortenWorktreeSlug('add-dark-mode-toggle-to-settings-page'),
    ).toMatchInlineSnapshot(`"add-drk-md-tggl-t-sttngs-pg"`)
  })

  test('formatWorktreeName keeps user-provided slugs verbatim', () => {
    expect(
      formatWorktreeName('Configurable sidebar width by component'),
    ).toMatchInlineSnapshot(`"opencode/kimaki-configurable-sidebar-width-by-component"`)
    expect(formatWorktreeName('my-feature')).toMatchInlineSnapshot(`"opencode/kimaki-my-feature"`)
  })

  test('formatAutoWorktreeName compresses long auto-derived slugs', () => {
    expect(
      formatAutoWorktreeName('Configurable sidebar width by component'),
    ).toMatchInlineSnapshot(`"opencode/kimaki-cnfgrbl-sdbr-wdth-by-cmpnnt"`)
    expect(formatAutoWorktreeName('my-feature')).toMatchInlineSnapshot(`"opencode/kimaki-my-feature"`)
  })

  test('getManagedWorktreeDirectory writes under kimaki data dir and strips prefix', () => {
    const sandbox = createTestRoot()
    try {
      setDataDir(sandbox)
      const dir = getManagedWorktreeDirectory({
        directory: '/Users/test/projects/my-app',
        name: 'opencode/kimaki-cnfgrbl-sdbr-wdth-by-cmpnnt',
      })
      // Must sit inside <dataDir>/worktrees/<8hash>/<basename>
      const rel = path.relative(sandbox, dir)
      const parts = rel.split(path.sep)
      expect({
        topLevel: parts[0],
        hashLength: parts[1]?.length,
        basename: parts[2],
        partsCount: parts.length,
      }).toMatchInlineSnapshot(`
        {
          "basename": "cnfgrbl-sdbr-wdth-by-cmpnnt",
          "hashLength": 8,
          "partsCount": 3,
          "topLevel": "worktrees",
        }
      `)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('parseGitWorktreeListPorcelain', () => {
  test('parses porcelain output, skips main worktree', () => {
    const output = [
      'worktree /Users/me/project',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/.local/share/opencode/worktree/hash/opencode-kimaki-feature',
      'HEAD def456',
      'branch refs/heads/opencode/kimaki-feature',
      '',
      'worktree /Users/me/project-manual-wt',
      'HEAD 789abc',
      'branch refs/heads/my-branch',
      '',
    ].join('\n')

    expect(parseGitWorktreeListPorcelain(output)).toMatchInlineSnapshot(`
      [
        {
          "branch": "opencode/kimaki-feature",
          "detached": false,
          "directory": "/Users/me/.local/share/opencode/worktree/hash/opencode-kimaki-feature",
          "head": "def456",
          "locked": false,
          "prunable": false,
        },
        {
          "branch": "my-branch",
          "detached": false,
          "directory": "/Users/me/project-manual-wt",
          "head": "789abc",
          "locked": false,
          "prunable": false,
        },
      ]
    `)
  })

  test('handles detached HEAD worktrees', () => {
    const output = [
      'worktree /Users/me/project',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/detached-wt',
      'HEAD deadbeef',
      'detached',
      '',
    ].join('\n')

    const result = parseGitWorktreeListPorcelain(output)
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "branch": null,
          "detached": true,
          "directory": "/Users/me/detached-wt",
          "head": "deadbeef",
          "locked": false,
          "prunable": false,
        },
      ]
    `)
  })

  test('parses locked and prunable flags', () => {
    const output = [
      'worktree /Users/me/project',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/locked-wt',
      'HEAD aaa111',
      'branch refs/heads/feature-locked',
      'locked portable disk',
      '',
      'worktree /Users/me/prunable-wt',
      'HEAD bbb222',
      'branch refs/heads/stale-branch',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n')

    expect(parseGitWorktreeListPorcelain(output)).toMatchInlineSnapshot(`
      [
        {
          "branch": "feature-locked",
          "detached": false,
          "directory": "/Users/me/locked-wt",
          "head": "aaa111",
          "locked": true,
          "prunable": false,
        },
        {
          "branch": "stale-branch",
          "detached": false,
          "directory": "/Users/me/prunable-wt",
          "head": "bbb222",
          "locked": false,
          "prunable": true,
        },
      ]
    `)
  })

  test('returns empty array when only main worktree exists', () => {
    const output = [
      'worktree /Users/me/project',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
    ].join('\n')

    expect(parseGitWorktreeListPorcelain(output)).toMatchInlineSnapshot(`[]`)
  })
})
