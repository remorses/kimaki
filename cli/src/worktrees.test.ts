// Tests for reusable worktree and submodule initialization helpers.
// Uses temporary local git repositories to validate submodule behavior end to end.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  execAsync,
  getManagedWorktreeDirectory,
  mergeWorktree,
  parseGitWorktreeListPorcelain,
  resolveSessionWorkingDirectory,
  validateBranchRef,
} from './worktrees.js'
import {
  createWorktreeCore,
  parseGitmodulesFileContent as parseCoreGitmodulesFileContent,
  removeWorktreeCore,
  removeWorktreeFromOwnRepository,
  resolveGitCommit,
  resolveGitCommonDirectory,
  validateWorktreeIdentity,
} from './git-worktree-core.js'
import { RebaseConflictError, TargetDirtyWorktreeError } from './errors.js'
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

async function createTestWorktree({
  directory,
  name,
}: {
  directory: string
  name: string
}) {
  const baseCommit = await resolveGitCommit({ directory, ref: 'HEAD' })
  if (baseCommit instanceof Error) return baseCommit
  return createWorktreeCore({
    projectDirectory: directory,
    targetDirectory: getManagedWorktreeDirectory({ directory, name }),
    branchName: name,
    baseCommit,
  })
}

describe('worktrees', () => {
  test('plugin-safe gitmodules parser handles standard indented entries', () => {
    const parsed = parseCoreGitmodulesFileContent(`
[submodule "errore"]
	path = errore
	url = https://github.com/remorses/errore.git
`)

    expect(parsed).toMatchInlineSnapshot(`
      [
        {
          "name": "errore",
          "path": "errore",
          "url": "https://github.com/remorses/errore.git",
        },
      ]
    `)
  })

  test('worktree creation resolves local-only submodule commits from local source checkout', async () => {
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

      const worktreeResult = await createTestWorktree({
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
      const parentCommonDirectory = await resolveGitCommonDirectory({
        directory: parentRepo,
      })
      if (parentCommonDirectory instanceof Error) {
        throw parentCommonDirectory
      }
      const submoduleCommonDirectory = await resolveGitCommonDirectory({
        directory: path.join(worktreeResult.directory, 'errore'),
      })
      if (submoduleCommonDirectory instanceof Error) {
        throw submoduleCommonDirectory
      }
      expect({
        localOnlyShaLength: localOnlySha.length,
        worktreeSubmoduleShaLength: worktreeSubmoduleSha.length,
        sameCommit: localOnlySha === worktreeSubmoduleSha,
        belongsToParentClone: !path
          .relative(parentCommonDirectory, submoduleCommonDirectory)
          .startsWith(`..${path.sep}`),
      }).toMatchInlineSnapshot(`
        {
          "belongsToParentClone": true,
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

  test('worktree creation uses current HEAD even when origin does not have the commit', async () => {
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

      const worktreeResult = await createTestWorktree({
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

  test('worktree creation survives an unavailable submodule remote', async () => {
    const sandbox = createTestRoot()
    const submoduleRemote = path.join(sandbox, 'missing-remote.git')
    const submoduleSource = path.join(sandbox, 'submodule-source')
    const parentRepo = path.join(sandbox, 'parent')
    const worktreeName = `opencode/kimaki-missing-submodule-${Date.now()}`

    try {
      await git({ cwd: sandbox, args: ['init', '--bare', '-b', 'main', submoduleRemote] })
      await git({ cwd: sandbox, args: ['clone', submoduleRemote, submoduleSource] })
      await git({ cwd: submoduleSource, args: ['config', 'user.email', 'kimaki-tests@example.com'] })
      await git({ cwd: submoduleSource, args: ['config', 'user.name', 'Kimaki Tests'] })
      fs.writeFileSync(path.join(submoduleSource, 'README.md'), 'submodule\n')
      await git({ cwd: submoduleSource, args: ['add', 'README.md'] })
      await git({ cwd: submoduleSource, args: ['commit', '-m', 'submodule'] })
      await git({ cwd: submoduleSource, args: ['push', 'origin', 'HEAD:main'] })

      await git({ cwd: sandbox, args: ['init', '-b', 'main', parentRepo] })
      await git({ cwd: parentRepo, args: ['config', 'user.email', 'kimaki-tests@example.com'] })
      await git({ cwd: parentRepo, args: ['config', 'user.name', 'Kimaki Tests'] })
      fs.writeFileSync(path.join(parentRepo, 'README.md'), 'parent\n')
      await git({ cwd: parentRepo, args: ['add', 'README.md'] })
      await git({ cwd: parentRepo, args: ['commit', '-m', 'parent'] })
      await git({
        cwd: parentRepo,
        args: [
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          submoduleRemote,
          'missing',
        ],
      })
      await git({ cwd: parentRepo, args: ['commit', '-am', 'add submodule'] })
      await git({ cwd: parentRepo, args: ['submodule', 'deinit', '-f', '--all'] })
      fs.rmSync(path.join(parentRepo, '.git', 'modules', 'missing'), {
        recursive: true,
        force: true,
      })
      fs.rmSync(submoduleRemote, { recursive: true, force: true })

      const result = await createTestWorktree({
        directory: parentRepo,
        name: worktreeName,
      })
      if (result instanceof Error) throw result

      expect({
        directoryExists: fs.existsSync(result.directory),
        submoduleUnavailable: !fs.existsSync(path.join(result.directory, 'missing', '.git')),
      }).toMatchInlineSnapshot(`
        {
          "directoryExists": true,
          "submoduleUnavailable": true,
        }
      `)
    } finally {
      const managedDirectory = getManagedWorktreeDirectory({
        directory: parentRepo,
        name: worktreeName,
      })
      if (fs.existsSync(parentRepo)) {
        await git({
          cwd: parentRepo,
          args: ['worktree', 'remove', '--force', managedDirectory],
        }).catch(() => '')
      }
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('worktree removal succeeds when its branch was already deleted', async () => {
    const sandbox = createTestRoot()
    const parentRepo = path.join(sandbox, 'parent')
    const worktreeDirectory = path.join(sandbox, 'worktree')
    const branchName = 'opencode/kimaki-removed-branch'

    try {
      await git({ cwd: sandbox, args: ['init', '-b', 'main', parentRepo] })
      await git({ cwd: parentRepo, args: ['config', 'user.email', 'kimaki-tests@example.com'] })
      await git({ cwd: parentRepo, args: ['config', 'user.name', 'Kimaki Tests'] })
      fs.writeFileSync(path.join(parentRepo, 'README.md'), 'parent\n')
      await git({ cwd: parentRepo, args: ['add', 'README.md'] })
      await git({ cwd: parentRepo, args: ['commit', '-m', 'parent'] })
      await git({
        cwd: parentRepo,
        args: ['worktree', 'add', '-b', branchName, worktreeDirectory],
      })
      await git({ cwd: worktreeDirectory, args: ['switch', '--detach'] })
      await git({ cwd: parentRepo, args: ['branch', '-D', branchName] })

      const result = await removeWorktreeCore({
        projectDirectory: parentRepo,
        worktreeDirectory,
        branchName,
      })
      if (result instanceof Error) throw result

      expect(fs.existsSync(worktreeDirectory)).toBe(false)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('worktree identity mismatch is detected and cleaned from its actual clone', async () => {
    const sandbox = createTestRoot()
    const remote = path.join(sandbox, 'remote.git')
    const requestedClone = path.join(sandbox, 'requested')
    const otherClone = path.join(sandbox, 'other')
    const worktreeDirectory = path.join(sandbox, 'wrong-worktree')
    const branchName = 'opencode/kimaki-wrong-clone'

    try {
      await git({ cwd: sandbox, args: ['init', '--bare', '-b', 'main', remote] })
      await git({ cwd: sandbox, args: ['clone', remote, otherClone] })
      await git({ cwd: otherClone, args: ['config', 'user.email', 'kimaki-tests@example.com'] })
      await git({ cwd: otherClone, args: ['config', 'user.name', 'Kimaki Tests'] })
      fs.writeFileSync(path.join(otherClone, 'README.md'), 'old\n')
      await git({ cwd: otherClone, args: ['add', 'README.md'] })
      await git({ cwd: otherClone, args: ['commit', '-m', 'old'] })
      await git({ cwd: otherClone, args: ['push', 'origin', 'HEAD:main'] })

      await git({ cwd: sandbox, args: ['clone', remote, requestedClone] })
      await git({ cwd: requestedClone, args: ['config', 'user.email', 'kimaki-tests@example.com'] })
      await git({ cwd: requestedClone, args: ['config', 'user.name', 'Kimaki Tests'] })
      fs.writeFileSync(path.join(requestedClone, 'requested.txt'), 'new\n')
      await git({ cwd: requestedClone, args: ['add', 'requested.txt'] })
      await git({ cwd: requestedClone, args: ['commit', '-m', 'requested'] })

      const baseCommit = await git({
        cwd: requestedClone,
        args: ['rev-parse', 'HEAD'],
      })
      await git({
        cwd: otherClone,
        args: ['worktree', 'add', '-b', branchName, worktreeDirectory, 'HEAD'],
      })

      const validation = await validateWorktreeIdentity({
        projectDirectory: requestedClone,
        worktreeDirectory,
        baseCommit,
      })
      expect(validation).toBeInstanceOf(Error)

      const cleanup = await removeWorktreeFromOwnRepository({
        worktreeDirectory,
        branchName,
      })
      if (cleanup instanceof Error) throw cleanup
      const otherWorktrees = await git({
        cwd: otherClone,
        args: ['worktree', 'list', '--porcelain'],
      })
      const branchExists = await execAsync(
        `git show-ref --verify --quiet ${JSON.stringify(`refs/heads/${branchName}`)}`,
        { cwd: otherClone },
      )
        .then(() => true)
        .catch(() => false)

      expect({
        directoryRemoved: !fs.existsSync(worktreeDirectory),
        registrationRemoved: !otherWorktrees.includes(worktreeDirectory),
        branchRemoved: !branchExists,
      }).toMatchInlineSnapshot(`
        {
          "branchRemoved": true,
          "directoryRemoved": true,
          "registrationRemoved": true,
        }
      `)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('mergeWorktree rejects dirty checked-out target before local push', async () => {
    const sandbox = createTestRoot()
    const parentRepo = path.join(sandbox, 'parent')
    const worktreeDir = path.join(sandbox, 'feature-worktree')

    try {
      fs.mkdirSync(parentRepo, { recursive: true })
      await git({ cwd: parentRepo, args: ['init', '-b', 'main'] })
      await git({ cwd: parentRepo, args: ['config', 'user.email', 'kimaki-tests@example.com'] })
      await git({ cwd: parentRepo, args: ['config', 'user.name', 'Kimaki Tests'] })

      fs.writeFileSync(path.join(parentRepo, 'README.md'), 'v1\n', 'utf-8')
      await git({ cwd: parentRepo, args: ['add', 'README.md'] })
      await git({ cwd: parentRepo, args: ['commit', '-m', 'init'] })

      await git({ cwd: parentRepo, args: ['worktree', 'add', '-b', 'feature', worktreeDir] })
      fs.writeFileSync(path.join(worktreeDir, 'feature.md'), 'feature\n', 'utf-8')
      await git({ cwd: worktreeDir, args: ['add', 'feature.md'] })
      await git({ cwd: worktreeDir, args: ['commit', '-m', 'feature'] })

      fs.writeFileSync(path.join(parentRepo, 'README.md'), 'dirty main\n', 'utf-8')

      const result = await mergeWorktree({
        worktreeDir,
        mainRepoDir: parentRepo,
        worktreeName: 'feature',
        targetBranch: 'main',
      })

      expect(result).toBeInstanceOf(TargetDirtyWorktreeError)
      expect(await git({ cwd: parentRepo, args: ['rev-parse', 'main'] })).not.toBe(
        await git({ cwd: worktreeDir, args: ['rev-parse', 'HEAD'] }),
      )
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('mergeWorktree squash creates one target commit with the complete tree', async () => {
    const sandbox = createTestRoot()
    const parentRepo = path.join(sandbox, 'parent')
    const worktreeDir = path.join(sandbox, 'feature-worktree')

    try {
      fs.mkdirSync(parentRepo, { recursive: true })
      await git({ cwd: parentRepo, args: ['init', '-b', 'main'] })
      await git({ cwd: parentRepo, args: ['config', 'user.email', 'kimaki-tests@example.com'] })
      await git({ cwd: parentRepo, args: ['config', 'user.name', 'Kimaki Tests'] })

      fs.writeFileSync(path.join(parentRepo, 'README.md'), 'base\n', 'utf-8')
      await git({ cwd: parentRepo, args: ['add', 'README.md'] })
      await git({ cwd: parentRepo, args: ['commit', '-m', 'init'] })

      await git({ cwd: parentRepo, args: ['worktree', 'add', '-b', 'feature', worktreeDir] })
      fs.writeFileSync(path.join(worktreeDir, 'first.md'), 'first\n', 'utf-8')
      await git({ cwd: worktreeDir, args: ['add', 'first.md'] })
      await git({ cwd: worktreeDir, args: ['commit', '-m', 'add first file'] })
      fs.writeFileSync(path.join(worktreeDir, 'second.md'), 'second\n', 'utf-8')
      await git({ cwd: worktreeDir, args: ['add', 'second.md'] })
      await git({ cwd: worktreeDir, args: ['commit', '-m', 'add second file'] })

      fs.writeFileSync(path.join(parentRepo, 'target.md'), 'target\n', 'utf-8')
      await git({ cwd: parentRepo, args: ['add', 'target.md'] })
      await git({ cwd: parentRepo, args: ['commit', '-m', 'advance target'] })
      const targetBeforeMerge = await git({
        cwd: parentRepo,
        args: ['rev-parse', 'main'],
      })

      const result = await mergeWorktree({
        worktreeDir,
        mainRepoDir: parentRepo,
        worktreeName: 'feature',
        targetBranch: 'main',
        strategy: 'squash',
      })
      if (result instanceof Error) throw result

      const parent = await git({ cwd: parentRepo, args: ['rev-parse', 'main^'] })
      expect({
        sourceCommitCount: result.commitCount,
        targetCommitCount: Number(
          await git({
            cwd: parentRepo,
            args: ['rev-list', '--count', `${targetBeforeMerge}..main`],
          }),
        ),
        parentMatchesTarget: parent === targetBeforeMerge,
        subject: await git({ cwd: parentRepo, args: ['log', '-1', '--format=%s', 'main'] }),
        files: (await git({ cwd: parentRepo, args: ['ls-tree', '-r', '--name-only', 'main'] })).split('\n'),
        worktreeHead: await git({ cwd: worktreeDir, args: ['rev-parse', '--abbrev-ref', 'HEAD'] }),
        featureBranchExists: await execAsync(
          'git show-ref --verify --quiet refs/heads/feature',
          { cwd: parentRepo },
        ).then(
          () => true,
          () => false,
        ),
      }).toMatchInlineSnapshot(`
        {
          "featureBranchExists": false,
          "files": [
            "README.md",
            "first.md",
            "second.md",
            "target.md",
          ],
          "parentMatchesTarget": true,
          "sourceCommitCount": 2,
          "subject": "Merge worktree feature",
          "targetCommitCount": 1,
          "worktreeHead": "HEAD",
        }
      `)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('mergeWorktree keeps reporting a paused rebase conflict on retry', async () => {
    const sandbox = createTestRoot()
    const parentRepo = path.join(sandbox, 'parent')
    const worktreeDir = path.join(sandbox, 'feature-worktree')

    try {
      fs.mkdirSync(parentRepo, { recursive: true })
      await git({ cwd: parentRepo, args: ['init', '-b', 'main'] })
      await git({ cwd: parentRepo, args: ['config', 'user.email', 'kimaki-tests@example.com'] })
      await git({ cwd: parentRepo, args: ['config', 'user.name', 'Kimaki Tests'] })
      fs.writeFileSync(path.join(parentRepo, 'conflict.txt'), 'base\n', 'utf-8')
      await git({ cwd: parentRepo, args: ['add', 'conflict.txt'] })
      await git({ cwd: parentRepo, args: ['commit', '-m', 'init'] })

      await git({ cwd: parentRepo, args: ['worktree', 'add', '-b', 'feature', worktreeDir] })
      fs.writeFileSync(path.join(worktreeDir, 'conflict.txt'), 'feature\n', 'utf-8')
      await git({ cwd: worktreeDir, args: ['commit', '-am', 'feature change'] })
      fs.writeFileSync(path.join(parentRepo, 'conflict.txt'), 'target\n', 'utf-8')
      await git({ cwd: parentRepo, args: ['commit', '-am', 'target change'] })

      const first = await mergeWorktree({
        worktreeDir,
        mainRepoDir: parentRepo,
        worktreeName: 'feature',
        targetBranch: 'main',
        strategy: 'squash',
      })
      const retry = await mergeWorktree({
        worktreeDir,
        mainRepoDir: parentRepo,
        worktreeName: 'feature',
        targetBranch: 'main',
        strategy: 'squash',
      })

      expect({
        first: first instanceof Error ? first.name : 'success',
        retry: retry instanceof Error ? retry.name : 'success',
      }).toMatchInlineSnapshot(`
        {
          "first": "RebaseConflictError",
          "retry": "RebaseConflictError",
        }
      `)
      expect(first).toBeInstanceOf(RebaseConflictError)
      expect(retry).toBeInstanceOf(RebaseConflictError)
    } finally {
      await execAsync('git rebase --abort', { cwd: worktreeDir }).catch(() => undefined)
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('validateBranchRef does not execute shell syntax from a branch value', async () => {
    const sandbox = createTestRoot()
    const marker = path.join(sandbox, 'injected')

    try {
      await git({ cwd: sandbox, args: ['init', '-b', 'main'] })
      const result = await validateBranchRef({
        directory: sandbox,
        ref: `feature/$(touch ${marker})`,
      })

      expect({
        rejected: result instanceof Error,
        commandExecuted: fs.existsSync(marker),
      }).toMatchInlineSnapshot(`
        {
          "commandExecuted": false,
          "rejected": true,
        }
      `)
    } finally {
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

  test('resolveSessionWorkingDirectory accepts the project root', async () => {
    const sandbox = createTestRoot()
    try {
      const projectDirectory = path.join(sandbox, 'project')
      fs.mkdirSync(projectDirectory, { recursive: true })

      const result = await resolveSessionWorkingDirectory({
        projectDirectory,
        candidatePath: projectDirectory,
      })

      if (result instanceof Error) {
        throw result
      }
      expect({
        kind: result.kind,
        relativeDirectory: path.relative(projectDirectory, result.directory),
      }).toMatchInlineSnapshot(`
        {
          "kind": "project",
          "relativeDirectory": "",
        }
      `)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('resolveSessionWorkingDirectory accepts project subfolders', async () => {
    const sandbox = createTestRoot()
    try {
      const projectDirectory = path.join(sandbox, 'project')
      const subfolder = path.join(projectDirectory, 'restricted-task')
      fs.mkdirSync(subfolder, { recursive: true })

      const result = await resolveSessionWorkingDirectory({
        projectDirectory,
        candidatePath: subfolder,
      })

      if (result instanceof Error) {
        throw result
      }
      expect({
        kind: result.kind,
        relativeDirectory: path.relative(projectDirectory, result.directory),
      }).toMatchInlineSnapshot(`
        {
          "kind": "project",
          "relativeDirectory": "restricted-task",
        }
      `)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('resolveSessionWorkingDirectory accepts project worktrees', async () => {
    const sandbox = createTestRoot()
    const projectDirectory = path.join(sandbox, 'project')
    const worktreeDirectory = path.join(sandbox, 'feature-worktree')

    try {
      fs.mkdirSync(projectDirectory, { recursive: true })
      await git({ cwd: projectDirectory, args: ['init', '-b', 'main'] })
      await git({
        cwd: projectDirectory,
        args: ['config', 'user.email', 'kimaki-tests@example.com'],
      })
      await git({
        cwd: projectDirectory,
        args: ['config', 'user.name', 'Kimaki Tests'],
      })
      fs.writeFileSync(
        path.join(projectDirectory, 'README.md'),
        'project\n',
        'utf-8',
      )
      await git({ cwd: projectDirectory, args: ['add', 'README.md'] })
      await git({ cwd: projectDirectory, args: ['commit', '-m', 'init'] })
      await git({
        cwd: projectDirectory,
        args: ['worktree', 'add', '-b', 'feature', worktreeDirectory],
      })

      const result = await resolveSessionWorkingDirectory({
        projectDirectory,
        candidatePath: worktreeDirectory,
      })

      if (result instanceof Error) {
        throw result
      }
      expect({
        kind: result.kind,
        relativeDirectory: path.relative(sandbox, result.directory),
      }).toMatchInlineSnapshot(`
        {
          "kind": "worktree",
          "relativeDirectory": "feature-worktree",
        }
      `)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('resolveSessionWorkingDirectory rejects unrelated directories', async () => {
    const sandbox = createTestRoot()
    try {
      const projectDirectory = path.join(sandbox, 'project')
      const siblingDirectory = path.join(sandbox, 'other-project')
      fs.mkdirSync(projectDirectory, { recursive: true })
      fs.mkdirSync(siblingDirectory, { recursive: true })
      await git({ cwd: projectDirectory, args: ['init', '-b', 'main'] })

      const result = await resolveSessionWorkingDirectory({
        projectDirectory,
        candidatePath: siblingDirectory,
      })

      expect(result).toBeInstanceOf(Error)
      const message = result instanceof Error ? result.message : ''
      expect(
        message
          .replace(projectDirectory, '<project>')
          .replace(siblingDirectory, '<sibling>'),
      ).toMatchInlineSnapshot(
        `"Working directory must be inside <project> or a git worktree of it: <sibling>"`,
      )
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
