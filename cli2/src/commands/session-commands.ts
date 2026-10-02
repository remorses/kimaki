// Commands that start a session in a new thread: /new-session, /resume,
// /fork, /fork-subagent. Selects carry only the source session ID; the
// source thread comes from the interaction channel.
//
//   /new-session prompt files? agent?  ─▶ startSession (new thread, no start message)
//   /resume session (autocomplete)     ─▶ resume (binding moves to the new thread)
//   /fork ─▶ select a user message      ─▶ fork({ before })
//   /fork-subagent ─▶ select a child    ─▶ fork(child)

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js'

import { oc, type Bot, type PromptFile } from '../bot.ts'
import { ConfigError } from '../errors.ts'
import { selectRow, truncate } from '../format-parts.ts'
import { authorOf, replyError, resolveTarget, respondChoices, type InteractionRoutes } from '../interaction-context.ts'
import { fork, resume, startSession } from '../sessions.ts'
import { stripTurnContext } from '../system-prompt.ts'
import { resolveWorkingDirectory } from '../worktrees.ts'

const FORK_PREFIX = 'fork:'
const FORK_SUBAGENT_PREFIX = 'fork_sub:'
const MAX_OPTIONS = 25

// One line, at most `max` characters.
function flat(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max)
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

async function newSession(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  const text = interaction.options.getString('prompt', true).trim()
  if (!text) return replyError(interaction, new ConfigError({ reason: 'Write a prompt for the new session' }))
  const files = parseFileList({ value: interaction.options.getString('files') ?? '', directory: target.directory })
  if (files instanceof Error) return replyError(interaction, files)
  const agent = interaction.options.getString('agent')?.trim()
  await interaction.deferReply()
  const started = await startSession(bot, {
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

async function resumeCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  if (target.thread) {
    return replyError(interaction, new ConfigError({ reason: 'This command can only be used in project channels, not threads' }))
  }
  await interaction.deferReply()
  const result = await resume(bot, {
    channelId: target.channelId,
    sessionId: interaction.options.getString('session', true).trim(),
    author: authorOf(interaction),
  })
  if (result instanceof Error) return replyError(interaction, result)
  await interaction.editReply({ content: `Resumed session "${result.title}" in <#${result.threadId}>` })
}

// The thread's session for /fork and /fork-subagent; null after an error reply.
async function forkSource(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) {
    await replyError(interaction, target)
    return null
  }
  const sessionId = target.sessionId
  if (!sessionId) {
    await replyError(interaction, new ConfigError({ reason: 'This command can only be used in a thread with a session' }))
    return null
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  return sessionId
}

async function forkMenu(bot: Bot, interaction: ChatInputCommandInteraction) {
  const sessionId = await forkSource(bot, interaction)
  if (!sessionId) return
  const messages = await oc(bot, 'message.list', (client) =>
    client.message.list({ sessionID: sessionId, type: 'user', order: 'desc', limit: MAX_OPTIONS }),
  )
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
        customId: `${FORK_PREFIX}${sessionId}`,
        placeholder: 'Select a message to fork from',
        options: users.map((message, index) => ({
          label: flat(`${index + 1}. ${stripTurnContext(message.text) || '(attachment)'}`, 100),
          value: message.id,
          description: shortDate(message.time.created),
        })),
      }),
    ],
  })
}

async function forkSubagentMenu(bot: Bot, interaction: ChatInputCommandInteraction) {
  const sessionId = await forkSource(bot, interaction)
  if (!sessionId) return
  const children = await oc(bot, 'session.list', (client) =>
    client.session.list({ parentID: sessionId, order: 'desc', limit: MAX_OPTIONS }),
  )
  if (children instanceof Error) return replyError(interaction, children)
  if (children.data.length === 0) {
    await interaction.editReply({ content: 'No subagent sessions found in this thread' })
    return
  }
  await interaction.editReply({
    content: '**Fork Subagent Session**\nSelect a subagent session to fork into a new thread:',
    components: [
      selectRow({
        customId: `${FORK_SUBAGENT_PREFIX}${sessionId}`,
        placeholder: 'Select a subagent session to fork',
        options: children.data.map((child) => ({
          label: flat(`${child.agent ?? 'subagent'} · ${child.title ?? 'No description'}`, 100),
          value: child.id,
          description: shortDate(child.time.created),
        })),
      }),
    ],
  })
}

// The fork selects carry the source session ID; the source thread is the interaction channel.
async function forkSelected(bot: Bot, { interaction, subagents }: { interaction: StringSelectMenuInteraction; subagents: boolean }) {
  const sourceSessionId = interaction.customId.slice((subagents ? FORK_SUBAGENT_PREFIX : FORK_PREFIX).length)
  const selected = interaction.values[0]
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  if (!selected || !target.thread || target.sessionId !== sourceSessionId) {
    await interaction.update({ content: 'This selection expired. Run the command again.', components: [] })
    return
  }
  await interaction.deferUpdate()
  const subagent = await (async () => {
    if (!subagents) return undefined
    const child = await oc(bot, 'session.get', (client) => client.session.get({ sessionID: selected }))
    if (child instanceof Error) return child
    return { agent: child.agent ?? 'subagent', description: child.title ?? '' }
  })()
  if (subagent instanceof Error) return replyError(interaction, subagent)
  const result = await fork(bot, {
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

async function sessionAutocomplete(bot: Bot, interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused(true)
  const query = focused.value.trim()
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return respondChoices(interaction, target)
  const location = { directory: target.directory }
  if (focused.name === 'session') {
    const project = await oc(bot, 'location.get', (client) => client.location.get({ location: { directory: target.projectDirectory } }))
    if (project instanceof Error) return respondChoices(interaction, project)
    const sessions = await oc(bot, 'session.list', (client) =>
      client.session.list({ project: project.project.id, parentID: null, order: 'desc', limit: 100, ...(query && { search: query }) }),
    )
    if (sessions instanceof Error) return respondChoices(interaction, sessions)
    const inProject = await Promise.all(
      sessions.data.map(async (session) => {
        const resolved = await resolveWorkingDirectory({ projectDirectory: target.projectDirectory, candidate: session.location.directory })
        return !(resolved instanceof Error)
      }),
    )
    return respondChoices(
      interaction,
      sessions.data.filter((_, index) => inProject[index]).slice(0, MAX_OPTIONS).map((session) => {
        const suffix = ` (${shortDate(session.time.updated)})`
        return { name: `${flat(session.title ?? 'Untitled', 100 - suffix.length)}${suffix}`, value: session.id }
      }),
    )
  }
  if (focused.name === 'agent') {
    const agents = await oc(bot, 'agent.list', (client) => client.agent.list({ location }))
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
    const found = await oc(bot, 'file.find', (client) =>
      client.file.find({ location, query: parts[parts.length - 1]?.trim() ?? '', type: 'file', limit: MAX_OPTIONS }),
    )
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

export const sessionRoutes: InteractionRoutes = {
  commands: {
    'new-session': {
      definition: new SlashCommandBuilder()
        .setName('new-session')
        .setDescription('Start a new OpenCode session')
        .addStringOption((option) => option.setName('prompt').setDescription('Prompt content for the session').setRequired(true))
        .addStringOption((option) =>
          option.setName('files').setDescription('Files to attach (comma separated; autocomplete)').setAutocomplete(true).setMaxLength(6000),
        )
        .addStringOption((option) => option.setName('agent').setDescription('Agent to use for this session').setAutocomplete(true)),
      run: newSession,
      autocomplete: sessionAutocomplete,
    },
    resume: {
      definition: new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Resume an existing OpenCode session in a new thread')
        .addStringOption((option) =>
          option.setName('session').setDescription('The session to resume').setRequired(true).setAutocomplete(true),
        ),
      run: resumeCommand,
      autocomplete: sessionAutocomplete,
    },
    fork: { definition: new SlashCommandBuilder().setName('fork').setDescription('Fork the session from a past user message'), run: forkMenu },
    'fork-subagent': {
      definition: new SlashCommandBuilder().setName('fork-subagent').setDescription('Fork a subagent task session into a new thread'),
      run: forkSubagentMenu,
    },
  },
  selects: {
    [FORK_PREFIX]: (bot, interaction) => forkSelected(bot, { interaction, subagents: false }),
    [FORK_SUBAGENT_PREFIX]: (bot, interaction) => forkSelected(bot, { interaction, subagents: true }),
  },
}
