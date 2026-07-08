// Plugin-safe git worktree creation and removal primitives.
// This module must NOT import config.ts, logger.ts, or any module that
// transitively pulls them in. It is used by both:
//   - worktrees.ts (bot process — wraps with kimaki logger + config)
//   - kimaki-workspace-adaptor.ts (opencode server process — silent callbacks)
//
// All logging goes through an optional `log` callback so callers control output.

import fs from 'node:fs'
import path from 'node:path'
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
async function removeBrokenSubmoduleStubs(directory: string, log: WorktreeLog): Promise<void> {
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
      if (!headExists) {
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

async function validateSubmodulePointers(directory: string, log: WorktreeLog): Promise<void> {
  const submodulePaths = await getSubmodulePaths(directory, log)
  if (submodulePaths.length === 0) return

  const issues: string[] = []
  await Promise.all(
    submodulePaths.map(async (subPath) => {
      const gitFile = path.join(directory, subPath, '.git')
      try {
        const stat = await fs.promises.stat(gitFile)
        if (!stat.isFile()) return
        const content = await fs.promises.readFile(gitFile, 'utf-8')
        const match = content.match(/^gitdir:\s*(.+)$/m)
        const gitdir = match?.[1]?.trim()
        if (!gitdir) {
          issues.push(`${subPath}: missing gitdir pointer`)
          return
        }
        const resolvedGitdir = path.resolve(path.join(directory, subPath), gitdir)
        const headExists = await fs.promises.access(path.join(resolvedGitdir, 'HEAD')).then(() => true).catch(() => false)
        if (!headExists) {
          issues.push(`${subPath}: gitdir missing HEAD (${resolvedGitdir})`)
        }
      } catch {
        // skip
      }
    }),
  )

  if (issues.length > 0) {
    log.warn(`Submodule validation issues: ${issues.join('; ')}`)
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

/**
 * Create a git worktree with full submodule initialization and dependency install.
 * Plugin-safe: no config.ts or logger.ts imports. Logging is done via the `log`
 * callback (defaults to silent no-op for plugin use).
 */
export async function createWorktreeCore({
  projectDirectory,
  targetDirectory,
  branchName,
  baseBranch,
  onProgress,
  log = silentLog,
}: {
  projectDirectory: string
  targetDirectory: string
  branchName: string
  baseBranch?: string
  onProgress?: (phase: string) => void
  log?: WorktreeLog
}): Promise<WorktreeResult | Error> {
  if (fs.existsSync(targetDirectory)) {
    return new Error(`Worktree directory already exists: ${targetDirectory}`)
  }
  await fs.promises.mkdir(path.dirname(targetDirectory), { recursive: true })

  const targetRef = baseBranch || 'HEAD'
  const createCmd = `git worktree add ${JSON.stringify(targetDirectory)} -B ${JSON.stringify(branchName)} ${JSON.stringify(targetRef)}`
  const createResult = await execAsync(createCmd, {
    cwd: projectDirectory,
    timeout: SUBMODULE_INIT_TIMEOUT_MS,
  }).catch((e) =>
    new Error(`git worktree add failed: ${formatCommandError(e)}`, { cause: e }),
  )
  if (createResult instanceof Error) return createResult

  // Remove broken submodule stubs before init
  await removeBrokenSubmoduleStubs(targetDirectory, log)

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

  // Validate submodule pointers (non-fatal)
  await validateSubmodulePointers(targetDirectory, log)

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
    await execAsync(
      `git branch -D ${JSON.stringify(branchName)}`,
      { cwd: projectDirectory, timeout: 10_000 },
    ).catch(() => {/* branch may not exist */})
  }
}
