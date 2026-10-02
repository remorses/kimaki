// Worktrees and working directories: /cwd, /new-worktree, /worktrees,
// /merge-worktree, and the same writes for `kimaki worktree` (lock-routes.ts).
//
//   /new-worktree in a channel ─▶ startSession(run: false) in a new checkout
//   /new-worktree in a thread  ─▶ fork into a new checkout
//   /worktrees                 ─▶ list + Delete / auto-worktrees toggle / pages
//   /merge-worktree            ─▶ mergeWorktree, refused while a session runs there

import crypto from 'node:crypto'
import { ButtonStyle, ComponentType, type ButtonInteraction, type ChatInputCommandInteraction, type ThreadChannel } from 'discord.js'

import { oc, projectOf, rootSession, sessionDirectory, type Author, type Bot } from '../bot.ts'
import { ConfigError, DbError } from '../errors.ts'
import { canonicalPath } from '../project.ts'
import * as schema from '../schema.ts'
import { fork, sessionCwd, startSession } from '../sessions.ts'
import { authorOf, replyError, resolveTarget } from '../slash-commands.ts'
import {
  deleteWorktree,
  git,
  inside,
  listWorktrees,
  mergeWorktree,
  resolveWorkingDirectory,
  worktreeName,
  type GitWorktree,
} from '../worktrees.ts'

export const WORKTREE_PREFIX = 'worktree_'
export const WORKTREE_COMMANDS = new Set(['cwd', 'new-worktree', 'merge-worktree', 'worktrees'])
const PAGE_SIZE = 5
const identity = (tree: GitWorktree) => crypto.createHash('sha256').update(`${tree.directory}\0${tree.head}`).digest('hex').slice(0, 16)

// A new session in a fresh checkout. In a thread the session is a fork, so it keeps the context.
export async function newWorktree(
  bot: Bot,
  { channelId, sourceThread, name, baseBranch, author }: { channelId: string; sourceThread?: ThreadChannel; name?: string; baseBranch?: string; author: Author },
) {
  const slug = name || `session-${crypto.randomBytes(4).toString('hex')}`
  const valid = worktreeName(slug)
  if (valid instanceof Error) return valid
  if (sourceThread) {
    const sessionId = rootSession(bot, sourceThread.id)
    if (sessionId instanceof Error) return sessionId
    return fork(bot, { sourceThread, sessionId, author, name: `⬦ ${slug}`, worktree: { name: slug, baseBranch } })
  }
  const project = await projectOf(bot, channelId)
  if (project instanceof Error) return project
  if (!project) return new ConfigError({ reason: 'Use /new-worktree in a project channel.' })
  return startSession(bot, {
    channelId,
    directory: project.directory,
    route: { kind: 'steer', text: '' },
    author,
    messageId: crypto.randomUUID(),
    startMessageId: null,
    showInput: false,
    worktree: slug,
    baseBranch,
    run: false,
  })
}

export async function setAutoWorktrees(bot: Bot, { channelId, enabled }: { channelId: string; enabled: boolean }) {
  const values = { enabled: enabled ? 1 : 0 }
  const saved = await bot.db
    .insert(schema.channel_worktrees)
    .values({ channel_id: channelId, ...values })
    .onConflictDoUpdate({ target: schema.channel_worktrees.channel_id, set: values })
    .catch((cause) => new DbError({ operation: 'save channel worktrees', cause }))
  if (saved instanceof Error) return saved
  return { enabled }
}

// Linked worktrees of the channel's project and whether new sessions get one.
export async function channelWorktrees(bot: Bot, { channelId }: { channelId: string }) {
  const project = await bot.db.query.channel_directories
    .findFirst({ where: { channel_id: channelId }, with: { channel_worktree: true } })
    .catch((cause) => new DbError({ operation: 'find worktree project', cause }))
  if (project instanceof Error) return project
  if (!project) return new ConfigError({ reason: 'Choose a project channel.' })
  const entries = await listWorktrees({ projectDirectory: project.directory })
  if (entries instanceof Error) return entries
  return { entries, enabled: project.channel_worktree ? project.channel_worktree.enabled === 1 : bot.autoWorktrees }
}

// Remove a checkout or merge it into a local branch; refused while a session runs there.
export async function manageWorktree(
  bot: Bot,
  {
    channelId,
    directory,
    operation,
    strategy,
    targetBranch,
  }: { channelId: string; directory: string; operation: 'remove' | 'merge'; strategy?: 'rebase' | 'squash'; targetBranch?: string },
) {
  const project = await projectOf(bot, channelId)
  if (project instanceof Error) return project
  if (!project) return new ConfigError({ reason: 'Choose a project channel.' })
  const active = await oc(bot, 'check active worktree sessions', (client) => client.session.active())
  if (active instanceof Error) return active
  const root = operation === 'merge' ? await git({ directory, args: ['rev-parse', '--show-toplevel'] }) : directory
  if (root instanceof Error) return root
  const candidate = await canonicalPath(root)
  for (const sessionId of Object.keys(active)) {
    const cwd = await sessionDirectory(bot, sessionId)
    if (cwd instanceof Error) return cwd
    const insideCheckout = inside({ parent: candidate, candidate: await canonicalPath(cwd) })
    const inMergeTarget = operation === 'merge' && !(await resolveWorkingDirectory({ projectDirectory: project.directory, candidate: cwd }) instanceof Error)
    if (insideCheckout || inMergeTarget) {
      return new ConfigError({ reason: 'A session is running in this checkout or merge target. Wait for it to finish before modifying the worktree.' })
    }
  }
  if (operation === 'merge') return mergeWorktree({ projectDirectory: project.directory, directory: candidate, strategy, targetBranch })
  const removed = await deleteWorktree({ projectDirectory: project.directory, directory: candidate })
  if (removed instanceof Error) return removed
  return { removed: candidate }
}

// --- Discord

async function listMessage(bot: Bot, { channelId, requestedPage = 0 }: { channelId: string; requestedPage?: number }) {
  const result = await channelWorktrees(bot, { channelId })
  if (result instanceof Error) return result
  const pages = Math.max(1, Math.ceil(result.entries.length / PAGE_SIZE))
  const page = Math.min(Math.max(0, requestedPage), pages - 1)
  const entries = result.entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const lines = [
    `**Worktrees** (${page + 1}/${pages})`,
    `Automatic worktrees: **${result.enabled ? 'on' : 'off'}**`,
    ...entries.map((tree, index) => `${index + 1}. \`${tree.branch ?? 'detached HEAD'}\`\n   \`${tree.directory.slice(0, 200)}\`${tree.locked ? ' (locked)' : ''}`),
  ]
  if (!entries.length) lines.push('No linked worktrees. Create one with /new-worktree.')
  const button = ({ customId, label, disabled = false }: { customId: string; label: string; disabled?: boolean }) =>
    ({ type: ComponentType.Button as const, style: ButtonStyle.Secondary, custom_id: customId, label, disabled })
  const deletes = entries.map((tree, index) =>
    button({ customId: `${WORKTREE_PREFIX}remove:${identity(tree)}`, label: `Delete ${index + 1}`, disabled: tree.locked || tree.prunable }),
  )
  const controls = [
    button({ customId: `${WORKTREE_PREFIX}toggle:${result.enabled ? 'off' : 'on'}`, label: result.enabled ? 'Disable auto-worktrees' : 'Enable auto-worktrees' }),
    button({ customId: `${WORKTREE_PREFIX}page:${page - 1}`, label: 'Previous', disabled: page === 0 }),
    button({ customId: `${WORKTREE_PREFIX}page:${page + 1}`, label: 'Next', disabled: page === pages - 1 }),
  ]
  return {
    content: lines.join('\n').slice(0, 1900),
    components: [
      ...(deletes.length ? [{ type: ComponentType.ActionRow as const, components: deletes }] : []),
      { type: ComponentType.ActionRow as const, components: controls },
    ],
    allowedMentions: { parse: [] as never[] },
  }
}

export async function handleWorktreeCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  await interaction.deferReply()
  if (interaction.commandName === 'cwd') {
    if (!target.thread || !target.sessionId) return replyError(interaction, new ConfigError({ reason: 'Use /cwd in a session thread.' }))
    const result = await sessionCwd(bot, { thread: target.thread, directory: interaction.options.getString('path') ?? undefined })
    if (result instanceof Error) return replyError(interaction, result)
    const content = result.requestedDirectory ? `Directory change requested: \`${result.requestedDirectory}\`` : `Working directory: \`${result.directory}\``
    return interaction.editReply({ content })
  }
  if (interaction.commandName === 'worktrees') {
    const result = await listMessage(bot, { channelId: target.channelId })
    if (result instanceof Error) return replyError(interaction, result)
    return interaction.editReply(result)
  }
  if (interaction.commandName === 'new-worktree') {
    const result = await newWorktree(bot, {
      channelId: target.channelId,
      sourceThread: target.thread ?? undefined,
      name: interaction.options.getString('name') ?? undefined,
      baseBranch: interaction.options.getString('base-branch') ?? undefined,
      author: authorOf(interaction),
    })
    if (result instanceof Error) return replyError(interaction, result)
    return interaction.editReply({ content: `Worktree session ready in <#${result.threadId}>` })
  }
  if (!target.sessionId) return replyError(interaction, new ConfigError({ reason: 'Use /merge-worktree inside a worktree session thread.' }))
  const strategy = interaction.options.getString('strategy') ?? 'rebase'
  if (strategy !== 'rebase' && strategy !== 'squash') return replyError(interaction, new ConfigError({ reason: 'Choose rebase or squash.' }))
  const result = await manageWorktree(bot, {
    channelId: target.channelId,
    directory: target.directory,
    operation: 'merge',
    strategy,
    targetBranch: interaction.options.getString('target-branch') ?? undefined,
  })
  if (result instanceof Error) return replyError(interaction, result)
  const content = 'targetBranch' in result
    ? `Merged ${result.commitCount} commits into \`${result.targetBranch}\` (${result.sha}). Worktree retained with detached HEAD.`
    : 'Worktree operation complete.'
  await interaction.editReply({ content })
}

export async function handleWorktreeClick(bot: Bot, interaction: ButtonInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  const [operation, value] = interaction.customId.slice(WORKTREE_PREFIX.length).split(':')
  await interaction.deferUpdate()
  if (operation === 'toggle') {
    if (value !== 'on' && value !== 'off') return replyError(interaction, new ConfigError({ reason: 'Invalid worktree toggle. Run /worktrees again.' }))
    const result = await setAutoWorktrees(bot, { channelId: target.channelId, enabled: value === 'on' })
    if (result instanceof Error) return replyError(interaction, result)
  }
  if (operation === 'remove') {
    const result = await channelWorktrees(bot, { channelId: target.channelId })
    if (result instanceof Error) return replyError(interaction, result)
    const tree = result.entries.find((entry) => identity(entry) === value)
    if (!tree) return replyError(interaction, new ConfigError({ reason: 'Worktree changed or was removed. Run /worktrees again.' }))
    const removed = await manageWorktree(bot, { channelId: target.channelId, directory: tree.directory, operation: 'remove' })
    if (removed instanceof Error) return replyError(interaction, removed)
  }
  const page = operation === 'page' ? Number(value) : 0
  const result = await listMessage(bot, { channelId: target.channelId, requestedPage: Number.isSafeInteger(page) ? page : 0 })
  if (result instanceof Error) return replyError(interaction, result)
  const content = operation === 'remove'
    ? `Checkout removed. Existing sessions keep their cwd; use /cwd to choose another directory.\n${result.content}`.slice(0, 2000)
    : result.content
  await interaction.editReply({ ...result, content })
}
