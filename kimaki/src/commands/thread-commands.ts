// Commands for the session of the current thread: run control (/abort,
// /queue, /queue-command, /clear-queue, /btw), history (/compact, /undo,
// /redo) and info (/context-usage, /session-id, /diff). They only call the
// writers in prompt.ts and sessions.ts; session output comes from events.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'
import * as errore from 'errore'
import dedent from 'string-dedent'

import { oc, type Bot } from '../bot.ts'
import { ConfigError, DiscordError } from '../errors.ts'
import {
  authorOf,
  replyError,
  replyWithEcho,
  resolveTarget,
  respondChoices,
  sessionTarget,
  type InteractionRoutes,
  type SessionTarget,
} from '../interaction-context.ts'
import { shellQuote } from '../onboarding.ts'
import { abort, clearQueue, dispatch, redo, undo } from '../prompt.ts'
import type { Route } from '../routes.ts'
import { forkBtw } from '../sessions.ts'

const execFileAsync = promisify(execFile)

// Built-in OpenCode command that only makes sense in the TUI (V1 skipped it too).
export const SKIPPED_COMMANDS = new Set(['init'])

// A command that only works in a session thread; others get told where it works.
function inThread(run: (bot: Bot, interaction: ChatInputCommandInteraction, target: SessionTarget) => Promise<unknown>) {
  return async (bot: Bot, interaction: ChatInputCommandInteraction) => {
    const target = await sessionTarget(bot, interaction)
    if (!target) return
    return run(bot, interaction, target)
  }
}

export function sessionIdReply({
  sessionId,
  threadId,
  directory,
}: {
  sessionId: string
  threadId: string
  directory: string | null
}): string {
  const attach = directory ? `opencode2 ${shellQuote(directory)} --session ${sessionId}` : `opencode2 --session ${sessionId}`
  return dedent`
    **Session ID:** \`${sessionId}\`
    **Thread ID:** \`${threadId}\`
    **Attach command:**
    \`\`\`bash
    ${attach}
    \`\`\`
  `
}

// critique --json prints { url, id } or { error } on one stdout line.
export function parseCritiqueOutput(output: string): { ok: true; url: string; id: string } | { ok: false; error: string } | null {
  for (const line of output.trim().split('\n')) {
    if (!line.startsWith('{')) continue
    const parsed = errore.try(
      () => {
        const value: unknown = JSON.parse(line)
        return { value }
      },
      (cause) => new ConfigError({ reason: 'invalid critique output', cause }),
    )
    if (parsed instanceof Error || typeof parsed.value !== 'object' || parsed.value === null) continue
    const fields = new Map<string, unknown>(Object.entries(parsed.value))
    const error = fields.get('error')
    const url = fields.get('url')
    const id = fields.get('id')
    if (typeof error === 'string') return { ok: false, error }
    if (typeof url === 'string' && typeof id === 'string') return { ok: true, url, id }
  }
  return null
}

// --- Run control

async function abortCommand(bot: Bot, interaction: ChatInputCommandInteraction, { thread }: SessionTarget) {
  await interaction.deferReply()
  const result = await abort(bot, { threadId: thread.id })
  if (result instanceof Error) return replyError(interaction, result)
  const note = result.cleared > 0 ? `, cleared ${result.cleared} queued message${result.cleared > 1 ? 's' : ''}` : ''
  await interaction.editReply({ content: `Request **aborted**${note}` })
}

// /queue and /queue-command: the echo reply is the queued message the ack points at.
async function queueInput(bot: Bot, { interaction, thread, route, echo }: { interaction: ChatInputCommandInteraction; thread: SessionTarget['thread']; route: Route; echo: string }) {
  const author = authorOf(interaction)
  const reply = await replyWithEcho(interaction, { author, text: echo })
  if (reply instanceof Error) return replyError(interaction, reply)
  const result = await dispatch(bot, { thread, route, author, messageId: reply.id })
  if (result instanceof Error) return replyError(interaction, result)
}

async function queueCommand(bot: Bot, interaction: ChatInputCommandInteraction, { thread }: SessionTarget) {
  const text = interaction.options.getString('message', true).trim()
  return queueInput(bot, { interaction, thread, route: { kind: 'queue', text }, echo: text })
}

async function queueOpencodeCommand(bot: Bot, interaction: ChatInputCommandInteraction, { thread }: SessionTarget) {
  const name = interaction.options.getString('command')?.trim().replace(/^\//, '') ?? ''
  const args = (interaction.options.getString('arguments') ?? '').trim()
  if (!name) return replyError(interaction, new ConfigError({ reason: 'Pass a command name, for example /queue-command command:review' }))
  const echo = `/${name} ${args}`.trim()
  return queueInput(bot, { interaction, thread, route: { kind: 'command', name, arguments: args, queue: true }, echo })
}

async function queueCommandChoices(bot: Bot, interaction: AutocompleteInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return respondChoices(interaction, target)
  const commands = await oc(bot, 'command.list', (client) => client.command.list({ location: { directory: target.directory } }))
  if (commands instanceof Error) return respondChoices(interaction, commands)
  const query = interaction.options.getFocused().toLowerCase()
  return respondChoices(
    interaction,
    commands.data
      .filter((command) => !SKIPPED_COMMANDS.has(command.name) && command.name.toLowerCase().includes(query))
      .map((command) => ({ name: `/${command.name}${command.description ? ` - ${command.description}` : ''}`, value: command.name })),
  )
}

async function clearQueueCommand(bot: Bot, interaction: ChatInputCommandInteraction, { thread }: SessionTarget) {
  await interaction.deferReply()
  const result = await clearQueue(bot, { threadId: thread.id, position: interaction.options.getInteger('position') })
  if (result instanceof Error) return replyError(interaction, result)
  const content =
    result.cleared === 0 ? 'No queued messages' : `-# Cleared ${result.cleared} queued message${result.cleared > 1 ? 's' : ''}`
  await interaction.editReply({ content })
}

async function btwCommand(bot: Bot, interaction: ChatInputCommandInteraction, { thread }: SessionTarget) {
  const text = interaction.options.getString('prompt', true).trim()
  await interaction.deferReply()
  const result = await forkBtw(bot, { sourceThread: thread, text, author: authorOf(interaction), messageId: interaction.id })
  if (result instanceof Error) return replyError(interaction, result)
  await interaction.editReply({ content: `Session forked! Continue in <#${result.threadId}>` })
}

// --- History

async function compactCommand(bot: Bot, interaction: ChatInputCommandInteraction, { sessionId }: SessionTarget) {
  await interaction.deferReply()
  const result = await oc(bot, 'session.compact', (client) => client.session.compact({ sessionID: sessionId }))
  if (result instanceof Error) return replyError(interaction, result)
  await interaction.editReply({ content: 'Compacting the session context' })
}

async function undoCommand(bot: Bot, interaction: ChatInputCommandInteraction, { thread }: SessionTarget) {
  await interaction.deferReply()
  const result = await undo(bot, { threadId: thread.id })
  if (result instanceof Error) return replyError(interaction, result)
  if (!result.reverted) {
    await interaction.editReply({ content: 'No messages to undo' })
    return
  }
  await interaction.editReply({ content: 'Undone - removed the last turn from the session. File changes were kept' })
}

async function redoCommand(bot: Bot, interaction: ChatInputCommandInteraction, { thread }: SessionTarget) {
  await interaction.deferReply()
  const result = await redo(bot, { threadId: thread.id })
  if (result instanceof Error) return replyError(interaction, result)
  const content = {
    nothing: 'Nothing to redo - no previous undo found',
    all: 'Restored - session fully back to its previous state',
    step: 'Restored one step forward',
  }[result.restored]
  await interaction.editReply({ content })
}

// --- Info

async function contextUsageCommand(bot: Bot, interaction: ChatInputCommandInteraction, { sessionId, directory }: SessionTarget) {
  await interaction.deferReply()
  const [info, messages, models] = await Promise.all([
    oc(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId })),
    oc(bot, 'message.list', (client) => client.message.list({ sessionID: sessionId, type: 'assistant', order: 'desc', limit: 20 })),
    oc(bot, 'model.list', (client) => client.model.list({ location: { directory } })),
  ])
  if (info instanceof Error) return replyError(interaction, info)
  if (messages instanceof Error) return replyError(interaction, messages)
  const last = messages.data.find((message) => message.type === 'assistant' && message.tokens)
  if (!last || last.type !== 'assistant' || !last.tokens) {
    await interaction.editReply({ content: 'Token usage not available for this session yet' })
    return
  }
  const { tokens, model } = last
  const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  const limit = models instanceof Error ? null : models.data.find((candidate) => candidate.providerID === model.providerID && candidate.id === model.id)?.limit.context
  const formatted = total.toLocaleString('en-US')
  const lines = [
    limit
      ? `**Context usage:** ${Math.round((total / limit) * 100)}%, ${formatted} / ${limit.toLocaleString('en-US')} tokens`
      : `**Context usage:** ${formatted} tokens (context limit unavailable)`,
    `**Model:** ${model.providerID}/${model.id}`,
    ...(info.cost > 0 ? [`**Session cost:** $${info.cost.toFixed(4)}`] : []),
  ]
  await interaction.editReply({ content: lines.join('\n') })
}

async function sessionIdCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  if (!target.thread || !target.sessionId) {
    await interaction.reply({ content: 'Run /session-id inside a Kimaki session thread.', flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.reply({
    content: sessionIdReply({ sessionId: target.sessionId, threadId: target.thread.id, directory: target.directory }),
    flags: MessageFlags.Ephemeral,
  })
}

async function diffCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  await interaction.deferReply()
  const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: target.directory, timeout: 10_000 }).catch(
    (e) => new DiscordError({ operation: 'git status', cause: e }),
  )
  if (status instanceof Error) return replyError(interaction, new ConfigError({ reason: 'This project is not a git repository' }))
  if (!status.stdout.trim()) {
    await interaction.editReply({ content: 'No changes to show' })
    return
  }
  const title = `${path.basename(target.directory)}: Discord /diff`
  const upload = await execFileAsync('critique', ['--web', title, '--json'], { cwd: target.directory, timeout: 30_000 }).catch(
    (e: NodeJS.ErrnoException & { stdout?: string }) => e,
  )
  if (upload instanceof Error && upload.code === 'ENOENT') {
    return replyError(interaction, new ConfigError({ reason: 'critique is not installed. Install it with: npm i -g critique' }))
  }
  const output = upload instanceof Error ? (upload.stdout ?? '') : upload.stdout
  const result = parseCritiqueOutput(output)
  if (!result) return replyError(interaction, new ConfigError({ reason: `critique failed: ${output.slice(0, 200) || 'no output'}` }))
  if (!result.ok) return replyError(interaction, new ConfigError({ reason: result.error }))
  const embed = new EmbedBuilder().setTitle(title).setURL(result.url).setImage(`https://critique.work/og/${result.id}.png`)
  await interaction.editReply({ embeds: [embed] })
}

export const threadRoutes: InteractionRoutes = {
  commands: {
    btw: {
      definition: new SlashCommandBuilder()
        .setName('btw')
        .setDescription('Ask something without polluting or blocking the current session')
        .addStringOption((option) =>
          option.setName('prompt').setDescription('The message to send in the forked session').setRequired(true),
        ),
      run: inThread(btwCommand),
    },
    abort: {
      definition: new SlashCommandBuilder().setName('abort').setDescription('Stop the current run and clear the queue'),
      run: inThread(abortCommand),
    },
    queue: {
      definition: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Send a message after the current run finishes')
        .addStringOption((option) => option.setName('message').setDescription('The message to queue').setRequired(true)),
      run: inThread(queueCommand),
    },
    'clear-queue': {
      definition: new SlashCommandBuilder()
        .setName('clear-queue')
        .setDescription('Remove queued messages')
        .addIntegerOption((option) => option.setName('position').setDescription('Only this position (1 = next)').setMinValue(1)),
      run: inThread(clearQueueCommand),
    },
    'queue-command': {
      definition: new SlashCommandBuilder()
        .setName('queue-command')
        .setDescription('Queue an OpenCode command to run after the current run finishes')
        .addStringOption((option) =>
          option.setName('command').setDescription('The command to run').setRequired(true).setAutocomplete(true),
        )
        .addStringOption((option) => option.setName('arguments').setDescription('Arguments to pass to the command')),
      run: inThread(queueOpencodeCommand),
      autocomplete: queueCommandChoices,
    },
    compact: {
      definition: new SlashCommandBuilder().setName('compact').setDescription('Compact the session context by summarizing the history'),
      run: inThread(compactCommand),
    },
    undo: {
      definition: new SlashCommandBuilder().setName('undo').setDescription('Undo the last turn (file changes are kept)'),
      run: inThread(undoCommand),
    },
    redo: {
      definition: new SlashCommandBuilder().setName('redo').setDescription('Redo the previously undone turn'),
      run: inThread(redoCommand),
    },
    diff: {
      definition: new SlashCommandBuilder().setName('diff').setDescription('Show the git diff as a shareable URL'),
      run: diffCommand,
    },
    'context-usage': {
      definition: new SlashCommandBuilder().setName('context-usage').setDescription('Show token usage and context window percentage'),
      run: inThread(contextUsageCommand),
    },
    'session-id': {
      definition: new SlashCommandBuilder()
        .setName('session-id')
        .setDescription('Show the OpenCode session ID of this thread and how to open it in OpenCode'),
      run: sessionIdCommand,
    },
  },
}
