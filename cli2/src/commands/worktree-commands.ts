// Worktrees and working directories: /cwd, /new-worktree, /worktrees,
// /merge-worktree, and the same writes for `kimaki worktree` (lock-routes.ts).
//
//   /new-worktree in a channel ─▶ startSession(run: false) in a new checkout
//   /new-worktree in a thread  ─▶ fork into a new checkout
//   /worktrees                 ─▶ list + Delete / auto-worktrees toggle / pages
//   /merge-worktree            ─▶ mergeWorktree, refused while a session runs there

import crypto from 'node:crypto'
import { ButtonStyle, ComponentType, SlashCommandBuilder, type ButtonInteraction, type ChatInputCommandInteraction, type ThreadChannel } from 'discord.js'

import { oc, projectOf, rootSession, sessionDirectory, type Author, type Bot } from '../bot.ts'
import { ConfigError, DbError } from '../errors.ts'
import { canonicalPath } from '../file-edit-log.ts'
import * as schema from '../schema.ts'
import { authorOf, replyError, resolveTarget, type InteractionRoutes } from '../interaction-context.ts'
import { fork, sessionCwd, startSession } from '../sessions.ts'
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

const TOGGLE_PREFIX = 'worktree_toggle:'
const REMOVE_PREFIX = 'worktree_remove:'
const PAGE_PREFIX = 'worktree_page:'
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
    button({ customId: `${REMOVE_PREFIX}${identity(tree)}`, label: `Delete ${index + 1}`, disabled: tree.locked || tree.prunable }),
  )
  const controls = [
    button({ customId: `${TOGGLE_PREFIX}${result.enabled ? 'off' : 'on'}`, label: result.enabled ? 'Disable auto-worktrees' : 'Enable auto-worktrees' }),
    button({ customId: `${PAGE_PREFIX}${page - 1}`, label: 'Previous', disabled: page === 0 }),
    button({ customId: `${PAGE_PREFIX}${page + 1}`, label: 'Next', disabled: page === pages - 1 }),
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

// The command's project and session; null after an error reply. Every worktree command answers in public.
async function deferredTarget(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) {
    await replyError(interaction, target)
    return null
  }
  await interaction.deferReply()
  return target
}

async function cwdCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await deferredTarget(bot, interaction)
  if (!target) return
  if (!target.thread || !target.sessionId) return replyError(interaction, new ConfigError({ reason: 'Use /cwd in a session thread.' }))
  const result = await sessionCwd(bot, { thread: target.thread, directory: interaction.options.getString('path') ?? undefined })
  if (result instanceof Error) return replyError(interaction, result)
  const content = result.requestedDirectory ? `Directory change requested: \`${result.requestedDirectory}\`` : `Working directory: \`${result.directory}\``
  return interaction.editReply({ content })
}

async function worktreesCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await deferredTarget(bot, interaction)
  if (!target) return
  const result = await listMessage(bot, { channelId: target.channelId })
  if (result instanceof Error) return replyError(interaction, result)
  return interaction.editReply(result)
}

async function newWorktreeCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await deferredTarget(bot, interaction)
  if (!target) return
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

async function mergeWorktreeCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await deferredTarget(bot, interaction)
  if (!target) return
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

// The /worktrees buttons: `act` changes something, then the list shows again (on `page`).
function listButton({
  prefix,
  act,
}: {
  prefix: string
  act: (bot: Bot, input: { channelId: string; value: string }) => Promise<Error | { page: number; note: string | null }>
}) {
  return async (bot: Bot, interaction: ButtonInteraction) => {
    const target = await resolveTarget(bot, interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    await interaction.deferUpdate()
    const acted = await act(bot, { channelId: target.channelId, value: interaction.customId.slice(prefix.length) })
    if (acted instanceof Error) return replyError(interaction, acted)
    const result = await listMessage(bot, { channelId: target.channelId, requestedPage: Number.isSafeInteger(acted.page) ? acted.page : 0 })
    if (result instanceof Error) return replyError(interaction, result)
    const content = acted.note ? `${acted.note}\n${result.content}`.slice(0, 2000) : result.content
    await interaction.editReply({ ...result, content })
  }
}

export const worktreeRoutes: InteractionRoutes = {
  commands: {
    cwd: {
      definition: new SlashCommandBuilder().setName('cwd').setDescription('Show or change this session working directory')
        .addStringOption((option) => option.setName('path').setDescription('Project subfolder or linked worktree; relative to current cwd')),
      run: cwdCommand,
    },
    'new-worktree': {
      definition: new SlashCommandBuilder().setName('new-worktree').setDescription('Start an isolated Git worktree session; fork context when used in a thread')
        .addStringOption((option) => option.setName('name').setDescription('Lowercase letters, digits and hyphens'))
        .addStringOption((option) => option.setName('base-branch').setDescription('Starting Git ref (default: project HEAD)')),
      run: newWorktreeCommand,
    },
    worktrees: {
      definition: new SlashCommandBuilder().setName('worktrees').setDescription('List worktrees, delete a safe checkout, or toggle automatic worktrees'),
      run: worktreesCommand,
    },
    'merge-worktree': {
      definition: new SlashCommandBuilder().setName('merge-worktree').setDescription('Merge this worktree into a local branch')
        .addStringOption((option) => option.setName('strategy').setDescription('Merge strategy').addChoices({ name: 'Rebase', value: 'rebase' }, { name: 'Squash', value: 'squash' }))
        .addStringOption((option) => option.setName('target-branch').setDescription('Local target branch (default: project checkout branch)')),
      run: mergeWorktreeCommand,
    },
  },
  buttons: {
    [TOGGLE_PREFIX]: listButton({
      prefix: TOGGLE_PREFIX,
      act: async (bot, { channelId, value }) => {
        if (value !== 'on' && value !== 'off') return new ConfigError({ reason: 'Invalid worktree toggle. Run /worktrees again.' })
        const result = await setAutoWorktrees(bot, { channelId, enabled: value === 'on' })
        if (result instanceof Error) return result
        return { page: 0, note: null }
      },
    }),
    [REMOVE_PREFIX]: listButton({
      prefix: REMOVE_PREFIX,
      act: async (bot, { channelId, value }) => {
        const result = await channelWorktrees(bot, { channelId })
        if (result instanceof Error) return result
        const tree = result.entries.find((entry) => identity(entry) === value)
        if (!tree) return new ConfigError({ reason: 'Worktree changed or was removed. Run /worktrees again.' })
        const removed = await manageWorktree(bot, { channelId, directory: tree.directory, operation: 'remove' })
        if (removed instanceof Error) return removed
        return { page: 0, note: 'Checkout removed. Existing sessions keep their cwd; use /cwd to choose another directory.' }
      },
    }),
    [PAGE_PREFIX]: listButton({ prefix: PAGE_PREFIX, act: async (_bot, { value }) => ({ page: Number(value), note: null }) }),
  },
}
