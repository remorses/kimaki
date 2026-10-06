// Custom Git checkouts, as in cli/git-worktree-core.ts. OpenCode owns session cwd, not checkout creation.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as errore from 'errore'

import { ConfigError } from './errors.ts'
import { canonicalPath } from './file-edit-log.ts'
import { createLogger } from './logger.ts'

const logger = createLogger('WORKTREE')
const execAsync = promisify(execFile)

export class GitError extends errore.createTaggedError({ name: 'GitError', message: 'Git $operation failed: $detail' }) {}

export async function git({ directory, args, timeout = 10_000 }: { directory: string; args: string[]; timeout?: number }) {
  const result = await execAsync('git', ['-C', directory, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 })
    .catch((cause: Error & { stderr?: string }) => new GitError({ operation: args.join(' '), detail: cause.stderr?.trim() || cause.message, cause }))
  if (result instanceof Error) return result
  return result.stdout.trim()
}

export function inside({ parent, candidate }: { parent: string; candidate: string }) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function commonDirectory(directory: string) {
  const common = await git({ directory, args: ['rev-parse', '--git-common-dir'] })
  if (common instanceof Error) return common
  return canonicalPath(path.resolve(directory, common))
}

export type GitWorktree = { directory: string; head: string; branch: string | null; locked: boolean; prunable: boolean }

// -z avoids Git's quoted-path format and supports spaces/newlines in checkout paths.
export function parseWorktrees(output: string): GitWorktree[] {
  return output.split('\0\0').filter(Boolean).map((block) => {
    const fields = block.split('\0')
    return {
      directory: fields.find((field) => field.startsWith('worktree '))?.slice(9) ?? '',
      head: fields.find((field) => field.startsWith('HEAD '))?.slice(5) ?? '',
      branch: fields.find((field) => field.startsWith('branch refs/heads/'))?.slice(18) ?? null,
      locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')),
      prunable: fields.some((field) => field === 'prunable' || field.startsWith('prunable ')),
    }
  }).filter((entry) => entry.directory)
}

async function allWorktrees(projectDirectory: string) {
  const output = await git({ directory: projectDirectory, args: ['worktree', 'list', '--porcelain', '-z'] })
  if (output instanceof Error) return output
  return parseWorktrees(output)
}

export async function listWorktrees({ projectDirectory }: { projectDirectory: string }): Promise<GitWorktree[] | GitError> {
  const entries = await allWorktrees(projectDirectory)
  if (entries instanceof Error) return entries
  return entries.slice(1)
}

export async function resolveWorkingDirectory({ projectDirectory, candidate }: { projectDirectory: string; candidate: string }) {
  const directory = await fs.promises.realpath(candidate).catch((cause) => new ConfigError({ reason: `Directory not found: ${candidate}. Choose an existing directory.`, cause }))
  if (directory instanceof Error) return directory
  const stat = await fs.promises.stat(directory).catch((cause) => new ConfigError({ reason: `Cannot inspect ${directory}`, cause }))
  if (stat instanceof Error) return stat
  if (!stat.isDirectory()) return new ConfigError({ reason: `${directory} is not a directory` })
  const project = await canonicalPath(projectDirectory)
  if (inside({ parent: project, candidate: directory })) return directory
  const entries = await allWorktrees(project)
  if (entries instanceof Error) return new ConfigError({ reason: `Working directory must be inside ${project}. Add another project with kimaki project add.`, cause: entries })
  const common = await commonDirectory(project)
  if (common instanceof Error) return common
  const otherCommon = await commonDirectory(directory)
  if (otherCommon instanceof Error) return otherCommon
  if (common === otherCommon) {
    for (const entry of entries) {
      if (inside({ parent: await canonicalPath(entry.directory), candidate: directory })) return directory
    }
  }
  return new ConfigError({ reason: `Choose a directory inside ${project} or a linked worktree of the same clone. Use kimaki project add for another clone.` })
}

export function worktreeName(name: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) return new ConfigError({ reason: 'Use a worktree name of at most 64 lowercase letters, digits and hyphens.' })
  return name
}

export async function createWorktree({ projectDirectory, dataDir, name, baseBranch }: { projectDirectory: string; dataDir: string; name: string; baseBranch?: string }) {
  const slug = worktreeName(name)
  if (slug instanceof Error) return slug
  const common = await commonDirectory(projectDirectory)
  if (common instanceof Error) return common
  const base = await git({ directory: projectDirectory, args: ['rev-parse', '--verify', '--end-of-options', `${baseBranch || 'HEAD'}^{commit}`] })
  if (base instanceof Error) return base
  const hash = crypto.createHash('sha256').update(common).digest('hex').slice(0, 8)
  const parent = path.join(dataDir, 'worktrees', hash)
  const made = await fs.promises.mkdir(parent, { recursive: true }).catch((cause) => new ConfigError({ reason: 'Cannot create worktree parent', cause }))
  if (made instanceof Error) return made
  const directory = path.join(parent, slug)
  const branch = `opencode/kimaki-${slug}`
  logger.log(`creating ${branch} from ${baseBranch || 'HEAD'} in ${directory}`)
  const added = await git({ directory: projectDirectory, args: ['worktree', 'add', '-b', branch, '--', directory, base], timeout: 60_000 })
  if (added instanceof Error) return added
  const [head, identity] = await Promise.all([git({ directory, args: ['rev-parse', 'HEAD'] }), commonDirectory(directory)])
  if (head instanceof Error) return head
  if (identity instanceof Error) return identity
  if (head !== base || identity !== common) return new ConfigError({ reason: `Worktree identity mismatch at ${directory}. No session was started; inspect this checkout.` })
  const setup = await setupWorktree(directory)
  if (setup instanceof Error) return new ConfigError({ reason: `Worktree created at ${directory}, but setup failed: ${setup.message}. Fix setup there, then use send --cwd with this directory.`, cause: setup })
  return { directory: await canonicalPath(directory), branch }
}

async function setupWorktree(directory: string) {
  if (fs.existsSync(path.join(directory, '.gitmodules'))) {
    logger.log(`initializing submodules in ${directory}`)
    const result = await git({ directory, args: ['submodule', 'update', '--init', '--recursive'], timeout: 20 * 60_000 })
    if (result instanceof Error) return result
  }
  const lockfiles: Array<[string, string]> = [['pnpm-lock.yaml', 'pnpm'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']]
  const manager = lockfiles.find(([file]) => fs.existsSync(path.join(directory, file)))?.[1]
  if (!manager) return
  const args = manager === 'npm' ? ['ci'] : ['install', '--frozen-lockfile']
  logger.log(`running ${manager} ${args.join(' ')} in ${directory}`)
  const result = await execAsync(manager, args, { cwd: directory, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 })
    .catch((cause) => new ConfigError({ reason: `${manager} install failed`, cause }))
  if (result instanceof Error) return result
  logger.log(`setup complete in ${directory}`)
}

async function linkedWorktree({ projectDirectory, directory }: { projectDirectory: string; directory: string }) {
  const canonical = await canonicalPath(directory)
  if (canonical === await canonicalPath(projectDirectory)) return new ConfigError({ reason: 'Cannot remove or merge the project checkout itself. Choose a linked worktree.' })
  const entries = await listWorktrees({ projectDirectory })
  if (entries instanceof Error) return entries
  for (const entry of entries) {
    if ((await canonicalPath(entry.directory)) !== canonical) continue
    if (entry.locked || entry.prunable) return new ConfigError({ reason: 'Worktree is locked or missing. Inspect it with git worktree list.' })
    return { ...entry, directory: canonical }
  }
  return new ConfigError({ reason: 'Choose a linked worktree, not the main checkout. List them with kimaki worktree list.' })
}

async function clean(directory: string) {
  const status = await git({ directory, args: ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'] })
  if (status instanceof Error) return status
  if (status) return new ConfigError({ reason: `Uncommitted changes in ${directory}. Commit or discard them first.` })
}

export async function deleteWorktree(input: { projectDirectory: string; directory: string }) {
  const tree = await linkedWorktree(input)
  if (tree instanceof Error) return tree
  const status = await clean(tree.directory)
  if (status instanceof Error) return status
  // Exclude this worktree's branch: deleting its only checkout must not hide unique work.
  const refs = await git({ directory: input.projectDirectory, args: ['for-each-ref', '--format=%(refname)'] })
  if (refs instanceof Error) return refs
  const retained = refs.split('\n').filter((ref) => ref && ref !== `refs/heads/${tree.branch}`)
  const remaining = await git({ directory: input.projectDirectory, args: ['rev-list', tree.head, '--not', ...retained] })
  if (remaining instanceof Error) return remaining
  if (remaining) return new ConfigError({ reason: 'This worktree has unmerged commits. Merge or preserve them on another branch before deleting.' })
  logger.log(`removing ${tree.directory}`)
  const removed = await git({ directory: input.projectDirectory, args: ['worktree', 'remove', '--', tree.directory], timeout: 60_000 })
  if (removed instanceof GitError && String(removed.detail).includes('containing submodules')) {
    const stillClean = await clean(tree.directory)
    if (stillClean instanceof Error) return stillClean
    const forced = await git({ directory: input.projectDirectory, args: ['worktree', 'remove', '--force', '--', tree.directory], timeout: 60_000 })
    if (forced instanceof Error) return forced
    return
  }
  if (removed instanceof Error) return removed
  // Keep branch refs. Git remains the source of truth and no force-delete is needed.
}

export async function mergeWorktree({ projectDirectory, directory, strategy = 'rebase', targetBranch }: { projectDirectory: string; directory: string; strategy?: 'rebase' | 'squash'; targetBranch?: string }) {
  const tree = await linkedWorktree({ projectDirectory, directory })
  if (tree instanceof Error) return tree
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const rebasePath = await git({ directory, args: ['rev-parse', '--git-path', name] })
    if (rebasePath instanceof Error) return rebasePath
    if (fs.existsSync(path.resolve(directory, rebasePath))) return new ConfigError({ reason: 'A rebase is already paused. Resolve conflicts and run git rebase --continue, or git rebase --abort, before merging.' })
  }
  const status = await clean(directory)
  if (status instanceof Error) return status
  const current = await git({ directory: projectDirectory, args: ['branch', '--show-current'] })
  if (current instanceof Error) return current
  const target = targetBranch || current || 'main'
  const valid = await git({ directory, args: ['check-ref-format', `refs/heads/${target}`] })
  if (valid instanceof Error) return valid
  if (tree.branch === target) return new ConfigError({ reason: 'Source and target branches are the same. Choose another target.' })
  const targetRef = `refs/heads/${target}`
  const targetSha = await git({ directory, args: ['rev-parse', '--verify', targetRef] })
  if (targetSha instanceof Error) return targetSha
  const entries = await allWorktrees(projectDirectory)
  if (entries instanceof Error) return entries
  for (const entry of entries.filter((entry) => entry.branch === target)) {
    const targetStatus = await clean(entry.directory)
    if (targetStatus instanceof Error) return targetStatus
  }
  const count = await git({ directory, args: ['rev-list', '--count', `${targetRef}..HEAD`] })
  if (count instanceof Error) return count
  if (count === '0') return new ConfigError({ reason: `No commits to merge into ${target}.` })
  logger.log(`rebasing ${tree.branch || 'detached HEAD'} onto ${target}`)
  const rebased = await git({ directory, args: ['rebase', targetSha], timeout: 60_000 })
  if (rebased instanceof Error) return new ConfigError({ reason: `Rebase failed in ${directory}. Resolve conflicts and run git rebase --continue, then retry the merge.`, cause: rebased })
  const head = await git({ directory, args: ['rev-parse', 'HEAD'] })
  if (head instanceof Error) return head
  const mergeSha = await (async () => {
    if (strategy === 'rebase') return head
    const treeSha = await git({ directory, args: ['rev-parse', 'HEAD^{tree}'] })
    if (treeSha instanceof Error) return treeSha
    return git({ directory, args: ['commit-tree', treeSha, '-p', targetSha, '-m', `Merge worktree ${tree.branch || path.basename(directory)}`] })
  })()
  if (mergeSha instanceof Error) return mergeSha
  const unchanged = await git({ directory, args: ['rev-parse', targetRef] })
  if (unchanged instanceof Error) return unchanged
  if (unchanged !== targetSha) return new ConfigError({ reason: 'Target branch changed during the merge. Retry; no target update was made.' })
  const common = await commonDirectory(directory)
  if (common instanceof Error) return common
  logger.log(`fast-forwarding local ${target}`)
  const pushed = await git({ directory, args: ['push', '--receive-pack=git -c receive.denyCurrentBranch=updateInstead receive-pack', common, `${mergeSha}:${targetRef}`], timeout: 30_000 })
  if (pushed instanceof Error) return pushed
  const detached = await git({ directory, args: ['switch', '--detach', mergeSha] })
  if (detached instanceof Error) return new ConfigError({ reason: `Merged into ${target}, but cleanup failed. Inspect ${directory} before retrying.`, cause: detached })
  // The source ref is intentionally retained; deletion never needs a force flag.
  return { targetBranch: target, commitCount: Number(count), sha: mergeSha.slice(0, 8) }
}
