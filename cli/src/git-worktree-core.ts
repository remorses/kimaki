// Plugin-safe Git worktree creation, identity validation, and removal primitives.
// This module must NOT import config.ts, logger.ts, or any module that
// transitively pulls them in. It is used by both:
//   - worktrees.ts (bot process — wraps with kimaki logger + config)
//   - kimaki-workspace-adaptor.ts (opencode server process — silent callbacks)
//
// All logging goes through an optional `log` callback so callers control output.

import fs from 'node:fs'
import path from 'node:path'
import * as errore from 'errore'
import { execAsync } from './exec-async.js'

const SUBMODULE_INIT_TIMEOUT_MS = 20 * 60_000
const INSTALL_TIMEOUT_MS = 60_000

const LOCKFILE_TO_INSTALL_COMMAND: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm install'],
  ['bun.lock', 'bun install'],
  ['bun.lockb', 'bun install'],
  ['yarn.lock', 'yarn install'],
  ['package-lock.json', 'npm install'],
]

export type WorktreeLog = {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export const KIMAKI_WORKTREE_ADAPTER_TYPE = 'kimaki-worktree'

export class WorktreeIdentityError extends errore.createTaggedError({
  name: 'WorktreeIdentityError',
  message: 'Created worktree does not match the requested checkout: $reason',
}) {}

export type KimakiWorktreeIdentity = {
  projectDirectory: string
  baseCommit: string
  expectedCommonGitDirectory: string
}

export function parseKimakiWorktreeIdentity(
  extra: Partial<KimakiWorktreeIdentity> | null,
): KimakiWorktreeIdentity | Error {
  if (!extra) {
    return new Error('Kimaki worktree identity is missing')
  }
  const { projectDirectory, baseCommit, expectedCommonGitDirectory } = extra
  if (typeof projectDirectory !== 'string' || !path.isAbsolute(projectDirectory)) {
    return new Error('Kimaki worktree project directory must be absolute')
  }
  if (typeof baseCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(baseCommit)) {
    return new Error('Kimaki worktree base commit must be a full commit SHA')
  }
  if (
    typeof expectedCommonGitDirectory !== 'string' ||
    !path.isAbsolute(expectedCommonGitDirectory)
  ) {
    return new Error('Kimaki worktree common Git directory must be absolute')
  }
  return { projectDirectory, baseCommit, expectedCommonGitDirectory }
}

const silentLog: WorktreeLog = {
  info() {},
  warn() {},
  error() {},
}

type CommandError = Error & {
  cmd?: string
  stderr?: string
  stdout?: string
  signal?: NodeJS.Signals
  killed?: boolean
}

function formatCommandError(error: CommandError): string {
  const parts: string[] = [error.message]
  if (error.cmd) parts.push(`cmd=${error.cmd}`)
  if (error.signal) parts.push(`signal=${error.signal}`)
  if (error.killed) parts.push('process=killed')
  if (error.stderr?.trim()) parts.push(`stderr=${error.stderr.trim()}`)
  if (error.stdout?.trim()) parts.push(`stdout=${error.stdout.trim()}`)
  return parts.join(' | ')
}

// ─── Submodule helpers ───────────────────────────────────────────────────────

type GitSubmoduleConfig = {
  name: string
  path: string
  url: string | null
}

export function parseGitmodulesFileContent(
  content: string,
): GitSubmoduleConfig[] | Error {
  const lines = content.split('\n')
  const configs: GitSubmoduleConfig[] = []
  let currentName: string | null = null
  let currentPath: string | null = null
  let currentUrl: string | null = null

  const flushCurrent = () => {
    if (!currentName || !currentPath) return
    configs.push({ name: currentName, path: currentPath, url: currentUrl })
    currentName = null
    currentPath = null
    currentUrl = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sectionMatch = line.match(/^\[submodule\s+"([^"]+)"\]/)
    if (sectionMatch?.[1]) {
      flushCurrent()
      currentName = sectionMatch[1]
      currentPath = null
      currentUrl = null
      continue
    }
    if (!currentName) continue
    const kvMatch = line.match(/^([^=\s]+)\s*=\s*(.*)$/)
    const key = kvMatch?.[1]
    const value = kvMatch?.[2]
    if (!key || value === undefined) continue
    if (key === 'path') currentPath = value
    if (key === 'url') currentUrl = value
  }
  flushCurrent()
  return configs
}

async function readSubmoduleConfigs(directory: string): Promise<GitSubmoduleConfig[] | Error> {
  const gitmodulesPath = path.join(directory, '.gitmodules')
  try {
    await fs.promises.access(gitmodulesPath)
  } catch {
    return []
  }
  try {
    const content = await fs.promises.readFile(gitmodulesPath, 'utf-8')
    return parseGitmodulesFileContent(content)
  } catch (e) {
    return new Error(`Failed to read ${gitmodulesPath}`, { cause: e })
  }
}

async function getSubmodulePaths(directory: string, log: WorktreeLog): Promise<string[]> {
  const configs = await readSubmoduleConfigs(directory)
  if (configs instanceof Error) {
    log.warn(`Failed reading submodules from ${directory}: ${configs.message}`)
    return []
  }
  return configs.map((c) => c.path)
}

async function hasSubmoduleGitMetadata(directory: string): Promise<boolean> {
  try {
    await fs.promises.access(path.join(directory, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * Remove broken submodule stubs created by `git worktree add`.
 * git worktree creates .git files pointing to incomplete gitdirs (missing HEAD).
 */
async function removeBrokenSubmoduleStubs({
  directory,
  expectedCommonGitDirectory,
  log,
}: {
  directory: string
  expectedCommonGitDirectory: string
  log: WorktreeLog
}): Promise<void> {
  const submodulePaths = await getSubmodulePaths(directory, log)
  for (const subPath of submodulePaths) {
    const fullPath = path.join(directory, subPath)
    const gitFile = path.join(fullPath, '.git')
    try {
      const stat = await fs.promises.stat(gitFile)
      if (!stat.isFile()) continue
      const content = await fs.promises.readFile(gitFile, 'utf-8')
      const match = content.match(/^gitdir:\s*(.+)$/m)
      if (!match?.[1]) continue
      const gitdir = path.resolve(fullPath, match[1].trim())
      const headFile = path.join(gitdir, 'HEAD')
      const headExists = await fs.promises.access(headFile).then(() => true).catch(() => false)
      const relativeGitdir = path.relative(expectedCommonGitDirectory, gitdir)
      const pointsOutsideExpectedRepository =
        relativeGitdir === '..' || relativeGitdir.startsWith(`..${path.sep}`)
      if (!headExists || pointsOutsideExpectedRepository) {
        log.info(`Removing broken submodule stub: ${subPath}`)
        await fs.promises.rm(fullPath, { recursive: true, force: true })
      }
    } catch {
      // skip
    }
  }
}

type SubmoduleReferencePlan = {
  path: string
  referenceDirectory: string | null
}

function buildSubmoduleReferencePlan({
  sourceDirectory,
  submodulePaths,
  existingSourceSubmoduleDirectories,
}: {
  sourceDirectory: string
  submodulePaths: string[]
  existingSourceSubmoduleDirectories: Set<string>
}): SubmoduleReferencePlan[] {
  return submodulePaths.map((submodulePath) => {
    const sourceSubmoduleDirectory = path.resolve(sourceDirectory, submodulePath)
    return {
      path: submodulePath,
      referenceDirectory: existingSourceSubmoduleDirectories.has(sourceSubmoduleDirectory)
        ? sourceSubmoduleDirectory
        : null,
    }
  })
}

function buildSubmoduleUpdateCommand(plan: SubmoduleReferencePlan): string {
  const args = ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive']
  if (plan.referenceDirectory) {
    args.push('--reference', plan.referenceDirectory)
  }
  args.push('--', plan.path)
  return `git ${args.map((a) => JSON.stringify(a)).join(' ')}`
}

async function initializeSubmodulesWithLocalReferences({
  sourceDirectory,
  worktreeDirectory,
  log,
}: {
  sourceDirectory: string
  worktreeDirectory: string
  log: WorktreeLog
}): Promise<void | Error> {
  const configs = await readSubmoduleConfigs(worktreeDirectory)
  if (configs instanceof Error) return configs
  if (configs.length === 0) return

  const sourceChecks = await Promise.all(
    configs.map(async (c) => {
      const dir = path.resolve(sourceDirectory, c.path)
      return { dir, exists: await hasSubmoduleGitMetadata(dir) }
    }),
  )
  const existingDirs = new Set(sourceChecks.filter((c) => c.exists).map((c) => c.dir))

  const plan = buildSubmoduleReferencePlan({
    sourceDirectory,
    submodulePaths: configs.map((c) => c.path),
    existingSourceSubmoduleDirectories: existingDirs,
  })

  for (const item of plan) {
    const cmd = buildSubmoduleUpdateCommand(item)
    const result = await execAsync(cmd, {
      cwd: worktreeDirectory,
      timeout: SUBMODULE_INIT_TIMEOUT_MS,
    }).catch((e) =>
      new Error(`Submodule ${item.path} failed: ${formatCommandError(e)}`, { cause: e }),
    )
    if (result instanceof Error) {
      log.warn(`Skipping submodule ${item.path}: ${result.message}`)
    }
  }
}

async function validateSubmodulePointers({
  directory,
  expectedCommonGitDirectory,
  log,
}: {
  directory: string
  expectedCommonGitDirectory: string
  log: WorktreeLog
}): Promise<void | Error> {
  const submoduleConfigs = await readSubmoduleConfigs(directory)
  if (submoduleConfigs instanceof Error) return submoduleConfigs
  const submodulePaths = submoduleConfigs.map(({ path: submodulePath }) => {
    return submodulePath
  })
  if (submodulePaths.length === 0) return

  const issues: string[] = []
  await Promise.all(
    submodulePaths.map(async (subPath) => {
      const gitFile = path.join(directory, subPath, '.git')
      try {
        const stat = await fs.promises.stat(gitFile)
        if (!stat.isFile()) {
          issues.push(`${subPath}: .git is not a file`)
          return
        }
        const content = await fs.promises.readFile(gitFile, 'utf-8')
        const match = content.match(/^gitdir:\s*(.+)$/m)
        const gitdir = match?.[1]?.trim()
        if (!gitdir) {
          issues.push(`${subPath}: missing gitdir pointer`)
          return
        }
        const resolvedGitdir = path.resolve(path.join(directory, subPath), gitdir)
        const relativeGitdir = path.relative(expectedCommonGitDirectory, resolvedGitdir)
        if (relativeGitdir === '..' || relativeGitdir.startsWith(`..${path.sep}`)) {
          issues.push(`${subPath}: gitdir belongs to another repository (${resolvedGitdir})`)
          return
        }
        const headExists = await fs.promises.access(path.join(resolvedGitdir, 'HEAD')).then(() => true).catch(() => false)
        if (!headExists) {
          issues.push(`${subPath}: gitdir missing HEAD (${resolvedGitdir})`)
          return
        }
        const [gitlinkResult, submoduleCommit] = await Promise.all([
          execAsync(`git ls-tree HEAD -- ${JSON.stringify(subPath)}`, {
            cwd: directory,
            timeout: 10_000,
          }).catch((e) => new Error(`failed to read gitlink for ${subPath}`, { cause: e })),
          resolveGitCommit({ directory: path.join(directory, subPath), ref: 'HEAD' }),
        ])
        if (gitlinkResult instanceof Error) {
          issues.push(`${subPath}: ${gitlinkResult.message}`)
          return
        }
        if (submoduleCommit instanceof Error) {
          issues.push(`${subPath}: ${submoduleCommit.message}`)
          return
        }
        const gitlinkCommit = gitlinkResult.stdout.trim().split(/\s+/)[2]
        if (gitlinkCommit !== submoduleCommit) {
          issues.push(
            `${subPath}: expected gitlink ${gitlinkCommit || 'missing'}, received ${submoduleCommit}`,
          )
        }
      } catch (e) {
        issues.push(
          `${subPath}: failed to validate .git (${e instanceof Error ? e.message : String(e)})`,
        )
      }
    }),
  )

  if (issues.length > 0) {
    return new Error(`Submodule validation failed: ${issues.join('; ')}`)
  }
}

function detectInstallCommand(directory: string): string | null {
  for (const [lockfile, command] of LOCKFILE_TO_INSTALL_COMMAND) {
    if (fs.existsSync(path.join(directory, lockfile))) {
      return command
    }
  }
  return null
}

async function runDependencyInstall(directory: string, log: WorktreeLog): Promise<void | Error> {
  const cmd = detectInstallCommand(directory)
  if (!cmd) return
  log.info(`Running "${cmd}" in ${directory}`)
  try {
    await execAsync(cmd, { cwd: directory, timeout: INSTALL_TIMEOUT_MS })
    log.info(`Dependencies installed in ${directory}`)
  } catch (e) {
    return new Error(`Install failed: ${formatCommandError(e)}`, { cause: e })
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export type WorktreeResult = {
  directory: string
  branch: string
}

async function canonicalizePath(value: string) {
  return await fs.promises.realpath(value).catch(() => path.resolve(value))
}

export async function resolveGitCommit({
  directory,
  ref,
}: {
  directory: string
  ref: string
}): Promise<string | Error> {
  const result = await execAsync(`git rev-parse --verify ${JSON.stringify(`${ref}^{commit}`)}`, {
    cwd: directory,
    timeout: 10_000,
  }).catch((e) => new Error(`Failed to resolve Git commit ${ref}`, { cause: e }))
  if (result instanceof Error) return result
  const commit = result.stdout.trim()
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    return new Error(`Git returned an invalid commit for ${ref}: ${commit}`)
  }
  return commit
}

export async function resolveGitCommonDirectory({
  directory,
}: {
  directory: string
}): Promise<string | Error> {
  const result = await execAsync('git rev-parse --git-common-dir', {
    cwd: directory,
    timeout: 10_000,
  }).catch(
    (e) => new Error(`Failed to resolve Git common directory for ${directory}`, { cause: e }),
  )
  if (result instanceof Error) return result
  const commonDirectory = path.isAbsolute(result.stdout.trim())
    ? result.stdout.trim()
    : path.resolve(directory, result.stdout.trim())
  return canonicalizePath(commonDirectory)
}

export async function validateWorktreeIdentity({
  projectDirectory,
  worktreeDirectory,
  expectedWorktreeDirectory,
  baseCommit,
  expectedCommonGitDirectory,
}: KimakiWorktreeIdentity & {
  worktreeDirectory: string
  expectedWorktreeDirectory?: string
}): Promise<{ commonGitDirectory: string; headCommit: string } | WorktreeIdentityError> {
  const sourceCommonGitDirectory = await resolveGitCommonDirectory({
    directory: projectDirectory,
  })
  if (sourceCommonGitDirectory instanceof Error) {
    return new WorktreeIdentityError({
      reason: sourceCommonGitDirectory.message,
      cause: sourceCommonGitDirectory,
    })
  }
  const expectedCommonDirectory = await canonicalizePath(expectedCommonGitDirectory)
  if (sourceCommonGitDirectory !== expectedCommonDirectory) {
    return new WorktreeIdentityError({
      reason: `registered checkout common directory changed from ${expectedCommonDirectory} to ${sourceCommonGitDirectory}`,
    })
  }
  if (
    expectedWorktreeDirectory &&
    path.resolve(worktreeDirectory) !== path.resolve(expectedWorktreeDirectory)
  ) {
    return new WorktreeIdentityError({
      reason: `expected directory ${expectedWorktreeDirectory}, received ${worktreeDirectory}`,
    })
  }

  const [commonGitDirectory, headCommit] = await Promise.all([
    resolveGitCommonDirectory({ directory: worktreeDirectory }),
    resolveGitCommit({ directory: worktreeDirectory, ref: 'HEAD' }),
  ])
  if (commonGitDirectory instanceof Error) {
    return new WorktreeIdentityError({
      reason: commonGitDirectory.message,
      cause: commonGitDirectory,
    })
  }
  if (headCommit instanceof Error) {
    return new WorktreeIdentityError({
      reason: headCommit.message,
      cause: headCommit,
    })
  }
  if (commonGitDirectory !== expectedCommonDirectory) {
    return new WorktreeIdentityError({
      reason: `expected common directory ${expectedCommonDirectory}, received ${commonGitDirectory}`,
    })
  }
  if (headCommit !== baseCommit) {
    return new WorktreeIdentityError({
      reason: `expected HEAD ${baseCommit}, received ${headCommit}`,
    })
  }
  return { commonGitDirectory, headCommit }
}

/**
 * Create a git worktree with full submodule initialization and dependency install.
 * Plugin-safe: no config.ts or logger.ts imports. Logging is done via the `log`
 * callback (defaults to silent no-op for plugin use).
 */
export async function createWorktreeCore({
  projectDirectory,
  targetDirectory,
  branchName,
  baseCommit,
  expectedCommonGitDirectory,
  onProgress,
  log = silentLog,
}: {
  projectDirectory: string
  targetDirectory: string
  branchName: string
  baseCommit: string
  expectedCommonGitDirectory: string
  onProgress?: (phase: string) => void
  log?: WorktreeLog
}): Promise<WorktreeResult | Error> {
  if (fs.existsSync(targetDirectory)) {
    return new Error(`Worktree directory already exists: ${targetDirectory}`)
  }
  await fs.promises.mkdir(path.dirname(targetDirectory), { recursive: true })

  const createCmd = `git worktree add ${JSON.stringify(targetDirectory)} -B ${JSON.stringify(branchName)} ${JSON.stringify(baseCommit)}`
  const createResult = await execAsync(createCmd, {
    cwd: projectDirectory,
    timeout: SUBMODULE_INIT_TIMEOUT_MS,
  }).catch((e) =>
    new Error(`git worktree add failed: ${formatCommandError(e)}`, { cause: e }),
  )
  if (createResult instanceof Error) return createResult

  const identityResult = await validateWorktreeIdentity({
    projectDirectory,
    worktreeDirectory: targetDirectory,
    expectedWorktreeDirectory: targetDirectory,
    baseCommit,
    expectedCommonGitDirectory,
  })
  if (identityResult instanceof Error) {
    const cleanupResult = await removeWorktreeFromOwnRepository({
      worktreeDirectory: targetDirectory,
      branchName,
    })
    if (cleanupResult instanceof Error) {
      return new WorktreeIdentityError({
        reason: `${identityResult.message}; cleanup failed: ${cleanupResult.message}`,
        cause: identityResult,
      })
    }
    return identityResult
  }

  // Remove broken submodule stubs before init
  await removeBrokenSubmoduleStubs({
    directory: targetDirectory,
    expectedCommonGitDirectory: identityResult.commonGitDirectory,
    log,
  })

  // Init submodules with local --reference directories
  log.info(`Initializing submodules in ${targetDirectory}`)
  const submoduleResult = await initializeSubmodulesWithLocalReferences({
    sourceDirectory: projectDirectory,
    worktreeDirectory: targetDirectory,
    log,
  })
  if (submoduleResult instanceof Error) {
    log.error(`Submodule initialization failed (non-fatal): ${submoduleResult.message}`)
  } else {
    log.info(`Submodules initialized in ${targetDirectory}`)
  }

  // Invalid submodule pointers can route later Git commands into another clone.
  const submoduleValidation = await validateSubmodulePointers({
    directory: targetDirectory,
    expectedCommonGitDirectory: identityResult.commonGitDirectory,
    log,
  })
  if (submoduleValidation instanceof Error) {
    const cleanupResult = await removeWorktreeCore({
      projectDirectory,
      worktreeDirectory: targetDirectory,
      branchName,
    })
    if (cleanupResult instanceof Error) {
      return new Error(`${submoduleValidation.message}; cleanup failed: ${cleanupResult.message}`, {
        cause: submoduleValidation,
      })
    }
    return submoduleValidation
  }

  // Dependency install (non-fatal)
  onProgress?.('Installing dependencies...')
  const installResult = await runDependencyInstall(targetDirectory, log)
  if (installResult instanceof Error) {
    log.error(`Dependency install failed (non-fatal): ${installResult.message}`)
  }

  return { directory: targetDirectory, branch: branchName }
}

/**
 * Remove a git worktree and its branch.
 * Plugin-safe version of deleteWorktree.
 */
export async function removeWorktreeCore({
  projectDirectory,
  worktreeDirectory,
  branchName,
}: {
  projectDirectory: string
  worktreeDirectory: string
  branchName: string
}): Promise<void | Error> {
  const removeResult = await execAsync(
    `git worktree remove --force ${JSON.stringify(worktreeDirectory)}`,
    { cwd: projectDirectory, timeout: 30_000 },
  ).catch((e) => new Error(`git worktree remove failed: ${formatCommandError(e)}`, { cause: e }))
  if (removeResult instanceof Error) return removeResult

  if (branchName) {
    const deleteResult = await execAsync(
      `git branch -D ${JSON.stringify(branchName)}`,
      { cwd: projectDirectory, timeout: 10_000 },
    ).catch((e) =>
      new Error(`git branch delete failed: ${formatCommandError(e)}`, { cause: e }),
    )
    if (deleteResult instanceof Error) return deleteResult
  }
}

export async function removeWorktreeFromOwnRepository({
  worktreeDirectory,
  branchName,
}: {
  worktreeDirectory: string
  branchName: string
}): Promise<void | Error> {
  if (!fs.existsSync(worktreeDirectory)) return
  const listResult = await execAsync('git worktree list --porcelain', {
    cwd: worktreeDirectory,
    timeout: 10_000,
  }).catch(
    (e) => new Error('Failed to locate the worktree repository', { cause: e }),
  )
  if (listResult instanceof Error) return listResult
  const mainWorktreeLine = listResult.stdout
    .split('\n')
    .find((line) => line.startsWith('worktree '))
  if (!mainWorktreeLine) {
    return new Error('Git returned no main worktree during cleanup')
  }
  return removeWorktreeCore({
    projectDirectory: mainWorktreeLine.slice('worktree '.length),
    worktreeDirectory,
    branchName,
  })
}
