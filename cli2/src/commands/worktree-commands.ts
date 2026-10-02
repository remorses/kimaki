import crypto from 'node:crypto'
import { ButtonStyle, ComponentType, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js'

import { ConfigError } from '../errors.ts'
import { authorOf, type CommandContext } from '../slash-commands.ts'
import type { GitWorktree } from '../worktrees.ts'

export const WORKTREE_PREFIX = 'worktree_'
const PAGE_SIZE = 5
const identity = (tree: GitWorktree) => crypto.createHash('sha256').update(`${tree.directory}\0${tree.head}`).digest('hex').slice(0, 16)

export function createWorktreeCommands({ actions, resolveTarget, replyError }: CommandContext) {
  async function list(channelId: string, requestedPage = 0) {
    const result = await actions.worktrees({ channelId })
    if (result instanceof Error) return result
    const pages = Math.max(1, Math.ceil(result.entries.length / PAGE_SIZE))
    const page = Math.min(Math.max(0, requestedPage), pages - 1)
    const entries = result.entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    const lines = [`**Worktrees** (${page + 1}/${pages})`, `Automatic worktrees: **${result.enabled ? 'on' : 'off'}**`, ...entries.map((tree, index) => `${index + 1}. \`${tree.branch ?? 'detached HEAD'}\`\n   \`${tree.directory.slice(0, 200)}\`${tree.locked ? ' (locked)' : ''}`)]
    if (!entries.length) lines.push('No linked worktrees. Create one with /new-worktree.')
    const buttons = entries.map((tree, index) => ({ type: ComponentType.Button as const, style: ButtonStyle.Secondary, custom_id: `${WORKTREE_PREFIX}remove:${identity(tree)}`, label: `Delete ${index + 1}`, disabled: tree.locked || tree.prunable }))
    return {
      content: lines.join('\n').slice(0, 1900),
      components: [
        ...(buttons.length ? [{ type: ComponentType.ActionRow as const, components: buttons }] : []),
        { type: ComponentType.ActionRow as const, components: [
          { type: ComponentType.Button as const, style: ButtonStyle.Secondary, custom_id: `${WORKTREE_PREFIX}toggle:${result.enabled ? 'off' : 'on'}`, label: result.enabled ? 'Disable auto-worktrees' : 'Enable auto-worktrees' },
          { type: ComponentType.Button as const, style: ButtonStyle.Secondary, custom_id: `${WORKTREE_PREFIX}page:${page - 1}`, label: 'Previous', disabled: page === 0 },
          { type: ComponentType.Button as const, style: ButtonStyle.Secondary, custom_id: `${WORKTREE_PREFIX}page:${page + 1}`, label: 'Next', disabled: page === pages - 1 },
        ] },
      ],
      allowedMentions: { parse: [] as never[] },
    }
  }

  async function handle(interaction: ChatInputCommandInteraction) {
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    await interaction.deferReply()
    if (interaction.commandName === 'cwd') {
      if (!target.thread || !target.sessionId) return replyError(interaction, new ConfigError({ reason: 'Use /cwd in a session thread.' }))
      const result = await actions.sessionCwd({ threadId: target.thread.id, directory: interaction.options.getString('path') ?? undefined })
      if (result instanceof Error) return replyError(interaction, result)
      return interaction.editReply({ content: result.requestedDirectory ? `Directory change requested: \`${result.requestedDirectory}\`` : `Working directory: \`${result.directory}\`` })
    }
    if (interaction.commandName === 'worktrees') {
      const result = await list(target.channelId)
      if (result instanceof Error) return replyError(interaction, result)
      return interaction.editReply(result)
    }
    if (interaction.commandName === 'new-worktree') {
      const result = await actions.newWorktree({ channelId: target.channelId, sourceThread: target.thread ?? undefined, name: interaction.options.getString('name') ?? undefined, baseBranch: interaction.options.getString('base-branch') ?? undefined, author: authorOf(interaction) })
      if (result instanceof Error) return replyError(interaction, result)
      return interaction.editReply({ content: `Worktree session ready in <#${result.threadId}>` })
    }
    if (!target.sessionId) return replyError(interaction, new ConfigError({ reason: 'Use /merge-worktree inside a worktree session thread.' }))
    const strategy = interaction.options.getString('strategy') ?? 'rebase'
    if (strategy !== 'rebase' && strategy !== 'squash') return replyError(interaction, new ConfigError({ reason: 'Choose rebase or squash.' }))
    const result = await actions.manageWorktree({ channelId: target.channelId, directory: target.directory, operation: 'merge', strategy, targetBranch: interaction.options.getString('target-branch') ?? undefined })
    if (result instanceof Error) return replyError(interaction, result)
    await interaction.editReply({ content: 'targetBranch' in result ? `Merged ${result.commitCount} commits into \`${result.targetBranch}\` (${result.sha}). Worktree retained with detached HEAD.` : 'Worktree operation complete.' })
  }

  async function click(interaction: ButtonInteraction) {
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    const [operation, value] = interaction.customId.slice(WORKTREE_PREFIX.length).split(':')
    await interaction.deferUpdate()
    if (operation === 'toggle') {
      if (value !== 'on' && value !== 'off') return replyError(interaction, new ConfigError({ reason: 'Invalid worktree toggle. Run /worktrees again.' }))
      const result = await actions.setWorktrees({ channelId: target.channelId, enabled: value === 'on' })
      if (result instanceof Error) return replyError(interaction, result)
    }
    if (operation === 'remove') {
      const result = await actions.worktrees({ channelId: target.channelId })
      if (result instanceof Error) return replyError(interaction, result)
      const tree = result.entries.find((entry) => identity(entry) === value)
      if (!tree) return replyError(interaction, new ConfigError({ reason: 'Worktree changed or was removed. Run /worktrees again.' }))
      const removed = await actions.manageWorktree({ channelId: target.channelId, directory: tree.directory, operation: 'remove' })
      if (removed instanceof Error) return replyError(interaction, removed)
    }
    const page = operation === 'page' ? Number(value) : 0
    const result = await list(target.channelId, Number.isSafeInteger(page) ? page : 0)
    if (result instanceof Error) return replyError(interaction, result)
    await interaction.editReply({ ...result, ...(operation === 'remove' && { content: `Checkout removed. Existing sessions keep their cwd; use /cwd to choose another directory.\n${result.content}`.slice(0, 2000) }) })
  }

  return { commands: new Set(['cwd', 'new-worktree', 'merge-worktree', 'worktrees']), handle, click }
}
