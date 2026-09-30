// Commands that start a session in a new thread: /new-session, /resume,
// /fork, /fork-subagent. Selects carry only the source session ID; the
// source thread comes from the interaction channel.
//
//   /new-session prompt files? agent?  ─▶ actions.startSession (new thread, no start message)
//   /resume session (autocomplete)     ─▶ actions.resume (binding moves to the new thread)
//   /fork ─▶ select a user message      ─▶ actions.fork({ before })
//   /fork-subagent ─▶ select a child    ─▶ actions.fork(child)

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ComponentType,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js'

import type { PromptFile } from '../actions.ts'
import { ConfigError, OpenCodeError } from '../errors.ts'
import { authorOf, respondChoices, type CommandContext } from '../slash-commands.ts'
import { stripTurnContext } from '../system-prompt.ts'

const FORK_PREFIX = 'fork:'
const FORK_SUBAGENT_PREFIX = 'fork_sub:'
const MAX_OPTIONS = 25

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function shortDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

// "a.ts, src/b.ts" -> files inside the project, as prompt attachments.
export function parseFileList({ value, directory }: { value: string; directory: string }): ConfigError | PromptFile[] {
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const files: PromptFile[] = []
  for (const name of names) {
    const absolute = path.resolve(directory, name)
    if (path.relative(directory, absolute).startsWith('..')) {
      return new ConfigError({ reason: `File ${name} is outside the project` })
    }
    if (!fs.existsSync(absolute)) return new ConfigError({ reason: `File not found: ${name}` })
    files.push({ uri: pathToFileURL(absolute).href, name })
  }
  return files
}

export function createSessionCommands({ actions, readClient, resolveTarget, replyError }: CommandContext) {
  async function newSession(interaction: ChatInputCommandInteraction) {
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    const text = interaction.options.getString('prompt', true).trim()
    if (!text) return replyError(interaction, new ConfigError({ reason: 'Write a prompt for the new session' }))
    const files = parseFileList({ value: interaction.options.getString('files') ?? '', directory: target.directory })
    if (files instanceof Error) return replyError(interaction, files)
    const agent = interaction.options.getString('agent')?.trim()
    await interaction.deferReply()
    const started = await actions.startSession({
      channelId: target.channelId,
      directory: target.directory,
      route: { kind: 'steer', text, ...(agent && { agent }) },
      author: authorOf(interaction),
      messageId: interaction.id,
      startMessageId: null,
      files,
    })
    if (started instanceof Error) return replyError(interaction, started)
    await interaction.editReply({ content: `Created new session in <#${started.threadId}>` })
  }

  async function resume(interaction: ChatInputCommandInteraction) {
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    if (target.thread) {
      return replyError(interaction, new ConfigError({ reason: 'This command can only be used in project channels, not threads' }))
    }
    await interaction.deferReply()
    const result = await actions.resume({
      channelId: target.channelId,
      sessionId: interaction.options.getString('session', true).trim(),
      author: authorOf(interaction),
    })
    if (result instanceof Error) return replyError(interaction, result)
    await interaction.editReply({ content: `Resumed session "${result.title}" in <#${result.threadId}>` })
  }

  async function forkMenu(interaction: ChatInputCommandInteraction) {
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    if (!target.sessionId) {
      return replyError(interaction, new ConfigError({ reason: 'This command can only be used in a thread with a session' }))
    }
    const client = readClient()
    if (client instanceof Error) return replyError(interaction, client)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const subagents = interaction.commandName === 'fork-subagent'
    if (subagents) {
      const children = await client.session
        .list({ parentID: target.sessionId, order: 'desc', limit: MAX_OPTIONS })
        .catch((e) => new OpenCodeError({ operation: 'session.list', cause: e }))
      if (children instanceof Error) return replyError(interaction, children)
      if (children.data.length === 0) {
        await interaction.editReply({ content: 'No subagent sessions found in this thread' })
        return
      }
      await interaction.editReply({
        content: '**Fork Subagent Session**\nSelect a subagent session to fork into a new thread:',
        components: [
          selectRow({
            customId: `${FORK_SUBAGENT_PREFIX}${target.sessionId}`,
            placeholder: 'Select a subagent session to fork',
            options: children.data.map((child) => ({
              label: truncate(`${child.agent ?? 'subagent'} · ${child.title ?? 'No description'}`, 100),
              value: child.id,
              description: shortDate(child.time.created),
            })),
          }),
        ],
      })
      return
    }
    const messages = await client.message
      .list({ sessionID: target.sessionId, type: 'user', order: 'desc', limit: MAX_OPTIONS })
      .catch((e) => new OpenCodeError({ operation: 'message.list', cause: e }))
    if (messages instanceof Error) return replyError(interaction, messages)
    const users = [...messages.data].reverse().flatMap((message) => (message.type === 'user' ? [message] : []))
    if (users.length === 0) {
      await interaction.editReply({ content: 'No user messages found in this session' })
      return
    }
    await interaction.editReply({
      content:
        '**Fork Session**\nSelect the user message to fork from. The forked session continues as if you had not sent that message:',
      components: [
        selectRow({
          customId: `${FORK_PREFIX}${target.sessionId}`,
          placeholder: 'Select a message to fork from',
          options: users.map((message, index) => ({
            label: truncate(`${index + 1}. ${stripTurnContext(message.text) || '(attachment)'}`, 100),
            value: message.id,
            description: shortDate(message.time.created),
          })),
        }),
      ],
    })
  }

  async function handleForkSelect(interaction: StringSelectMenuInteraction) {
    const subagents = interaction.customId.startsWith(FORK_SUBAGENT_PREFIX)
    const sourceSessionId = interaction.customId.slice((subagents ? FORK_SUBAGENT_PREFIX : FORK_PREFIX).length)
    const selected = interaction.values[0]
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    if (!selected || !target.thread || target.sessionId !== sourceSessionId) {
      await interaction.update({ content: 'This selection expired. Run the command again.', components: [] })
      return
    }
    await interaction.deferUpdate()
    const subagent = await (async () => {
      if (!subagents) return undefined
      const client = readClient()
      if (client instanceof Error) return client
      const child = await client.session
        .get({ sessionID: selected })
        .catch((e) => new OpenCodeError({ operation: 'session.get', cause: e }))
      if (child instanceof Error) return child
      return { agent: child.agent ?? 'subagent', description: child.title ?? '' }
    })()
    if (subagent instanceof Error) return replyError(interaction, subagent)
    const result = await actions.fork({
      sourceThread: target.thread,
      sessionId: subagents ? selected : sourceSessionId,
      ...(!subagents && { before: selected }),
      ...(subagent && { subagent }),
      author: authorOf(interaction),
    })
    if (result instanceof Error) return replyError(interaction, result)
    const label = subagents ? 'Subagent session forked!' : 'Session forked!'
    await interaction.editReply({ content: `${label} Continue in <#${result.threadId}>`, components: [] })
  }

  async function autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused(true)
    const query = focused.value.trim()
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return respondChoices(interaction, target)
    const client = readClient()
    if (client instanceof Error) return respondChoices(interaction, client)
    const location = { directory: target.directory }
    if (focused.name === 'session') {
      const sessions = await client.session
        .list({ directory: target.directory, parentID: null, order: 'desc', limit: MAX_OPTIONS, ...(query && { search: query }) })
        .catch((e) => new OpenCodeError({ operation: 'session.list', cause: e }))
      if (sessions instanceof Error) return respondChoices(interaction, sessions)
      return respondChoices(
        interaction,
        sessions.data.map((session) => {
          const suffix = ` (${shortDate(session.time.updated)})`
          return { name: `${truncate(session.title ?? 'Untitled', 100 - suffix.length)}${suffix}`, value: session.id }
        }),
      )
    }
    if (focused.name === 'agent') {
      const agents = await client.agent.list({ location }).catch((e) => new OpenCodeError({ operation: 'agent.list', cause: e }))
      if (agents instanceof Error) return respondChoices(interaction, agents)
      return respondChoices(
        interaction,
        agents.data
          .filter((agent) => agent.mode !== 'subagent' && !agent.hidden && agent.id.includes(query.toLowerCase()))
          .map((agent) => ({ name: agent.name, value: agent.id })),
      )
    }
    if (focused.name === 'files') {
      // Comma separated: complete the last entry, keep the ones before.
      const parts = focused.value.split(',')
      const done = parts.slice(0, -1).map((part) => part.trim()).filter(Boolean)
      const found = await client.file
        .find({ location, query: parts[parts.length - 1]?.trim() ?? '', type: 'file', limit: MAX_OPTIONS })
        .catch((e) => new OpenCodeError({ operation: 'file.find', cause: e }))
      if (found instanceof Error) return respondChoices(interaction, found)
      return respondChoices(
        interaction,
        found.data
          .map((entry) => ({ name: [...done, entry.path].join(', '), value: [...done, entry.path].join(', ') }))
          .filter((choice) => choice.value.length <= 100),
      )
    }
    return respondChoices(interaction, [])
  }

  const handlers: Record<string, (interaction: ChatInputCommandInteraction) => Promise<void>> = {
    'new-session': newSession,
    resume,
    fork: forkMenu,
    'fork-subagent': forkMenu,
  }

  return {
    commands: new Set(Object.keys(handlers)),
    async handle(interaction: ChatInputCommandInteraction): Promise<void> {
      await handlers[interaction.commandName]?.(interaction)
    },
    autocomplete,
    ownsSelect(customId: string): boolean {
      return customId.startsWith(FORK_PREFIX) || customId.startsWith(FORK_SUBAGENT_PREFIX)
    },
    handleSelect: handleForkSelect,
  }
}

export function selectRow({
  customId,
  placeholder,
  options,
}: {
  customId: string
  placeholder: string
  options: ReadonlyArray<{ label: string; value: string; description?: string; default?: boolean }>
}) {
  return {
    type: ComponentType.ActionRow as const,
    components: [
      {
        type: ComponentType.StringSelect as const,
        custom_id: customId,
        placeholder,
        options: options.slice(0, MAX_OPTIONS).map((option) => ({
          label: option.label.slice(0, 100) || '-',
          value: option.value,
          ...(option.description && { description: option.description.slice(0, 100) }),
          ...(option.default && { default: true }),
        })),
      },
    ],
  }
}
