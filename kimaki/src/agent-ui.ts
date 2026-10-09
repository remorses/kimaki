// Agent UI: `kimaki buttons` and `kimaki upload-request` prompts in a session
// thread, their buttons and the file upload modal.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { FileUploadBuilder, LabelBuilder, ModalBuilder, MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js'
import { sessionDirectory, type Bot } from './bot.ts'
import { ConfigError, DiscordError } from './errors.ts'
import type { InteractionRoutes } from './interaction-context.ts'
import { send } from './prompt.ts'
import type { AgentButton, AgentPrompt, ThreadView } from './thread-reducer.ts'

export function parseButton(value: string): ConfigError | AgentButton {
  const match = value.match(/:(white|blue|green|red)$/)
  const color = match?.[1] ?? 'white'
  const label = match ? value.slice(0, -match[0].length) : value
  if (!label.trim() || label.length > 80) return new ConfigError({ reason: 'Button labels must have 1 to 80 characters' })
  if (color !== 'white' && color !== 'blue' && color !== 'green' && color !== 'red') return new ConfigError({ reason: 'Unknown button color' })
  return { label, color }
}

type UploadResult = { paths: string[] } | { cancelled: true }

// A `kimaki upload-request` call waiting for the user's files.
type UploadWait = {
  resolve: (value: UploadResult) => void
  timer: ReturnType<typeof setTimeout>
  controller: AbortController
}

type AgentUiInput = {
  sessionId: string
  content: { buttons: AgentButton[] } | { prompt: string; maxFiles: number }
  fromShell?: boolean
  toolCall?: string
  signal: AbortSignal
}

export type AgentUi = {
  // Lock routes `buttons` and `upload-request` (lock-routes.ts). Buttons answer
  // at once; an upload request waits until the user uploads or it is dismissed.
  request: (input: AgentUiInput) => Promise<ConfigError | { shown: true } | UploadResult>
  // The upload modal: saves the files under <session cwd>/uploads/<id>/ and answers the waiting call.
  submitUpload: (interaction: ModalSubmitInteraction) => Promise<unknown>
  // Cancels the calls still waiting.
  stop: () => void
}

function cancelUpload(pending: UploadWait) {
  clearTimeout(pending.timer)
  pending.controller.abort()
  pending.resolve({ cancelled: true })
}

function promptShown(threads: Readonly<Record<string, ThreadView>>, id: string): boolean {
  return Object.values(threads).some((view) => view.agentUi.some((prompt) => prompt.id === id))
}

function shownPrompt(bot: Pick<Bot, 'store'>, { id, threadId }: { id: string; threadId: string }) {
  return bot.store.getState().threads[threadId]?.agentUi.find((prompt) => prompt.id === id)
}

// `kimaki buttons --from-shell` must post after its shell's tool line.
async function waitForShellCall(
  bot: Pick<Bot, 'store'>,
  { toolCall, signal }: { toolCall: string; signal: AbortSignal },
): Promise<ConfigError | void> {
  const seen = () =>
    Object.values(bot.store.getState().threads).some((view) => {
      const tool = view.tools[toolCall]
      return tool?.name === 'shell' && tool.phase === 'called'
    })
  if (seen()) return
  return new Promise((resolve) => {
    const finish = (value?: ConfigError) => {
      clearTimeout(timer)
      off()
      signal.removeEventListener('abort', abort)
      resolve(value)
    }
    const off = bot.store.subscribe(() => {
      if (seen()) finish()
    })
    const abort = () => finish(new ConfigError({ reason: 'Agent UI request cancelled' }))
    const timer = setTimeout(() => {
      finish(new ConfigError({ reason: 'No running shell call observed. Run this command from the session shell.' }))
    }, 10_000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else if (seen()) finish()
  })
}

// One per bot (bot.features.agentUi). The upload waits stay in this closure.
export function createAgentUi(bot: Pick<Bot, 'store' | 'eventLoop' | 'opencode'>): AgentUi {
  // Agent UI upload id -> the `kimaki upload-request` call waiting for files.
  const uploads = new Map<string, UploadWait>()

  // The one reactive side effect of uploads: a prompt that leaves every view
  // (dismissed by a new message, the session ended) cancels its waiting call.
  const unsubscribe = bot.store.subscribe((state, previous) => {
    for (const [id, pending] of uploads) {
      if (!promptShown(previous.threads, id) || promptShown(state.threads, id)) continue
      cancelUpload(pending)
      uploads.delete(id)
    }
  })

  async function request({ sessionId, content, fromShell, toolCall, signal }: AgentUiInput) {
    const threadId = bot.store.getState().sessionThreads[sessionId]
    if (!threadId) return new ConfigError({ reason: 'This session has no local Discord thread' })
    const prompt: AgentPrompt = { id: crypto.randomBytes(8).toString('hex'), sessionId, ...content }
    if (fromShell) {
      if (!toolCall) return new ConfigError({ reason: 'The Kimaki plugin must provide KIMAKI_TOOL_CALL for agent UI commands' })
      const waited = await waitForShellCall(bot, { toolCall, signal })
      if (waited instanceof Error) return waited
    }
    bot.eventLoop.dispatch(threadId, { type: 'kimaki.agent-ui', prompt })
    if (prompt.buttons) return { shown: true as const }
    return new Promise<UploadResult>((resolve) => {
      const finish = (value: UploadResult) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      }
      const abort = () => {
        bot.eventLoop.dispatch(threadId, { type: 'kimaki.agent-ui-dismiss', id: prompt.id })
        finish({ cancelled: true })
      }
      const timer = setTimeout(abort, 6 * 60_000)
      uploads.set(prompt.id, { resolve: finish, timer, controller: new AbortController() })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  async function submitUpload(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const threadId = interaction.channelId
    if (!threadId) return interaction.editReply({ content: 'Use this upload in its session thread' })
    const id = interaction.customId.split(':')[1] ?? ''
    const prompt = shownPrompt(bot, { id, threadId })
    const pending = uploads.get(id)
    if (!prompt || !pending) return interaction.editReply({ content: 'Upload request expired' })
    const active = () => uploads.get(id) === pending && !pending.controller.signal.aborted
    const directory = await sessionDirectory(bot, prompt.sessionId)
    if (!active()) return interaction.editReply({ content: 'Upload cancelled' })
    if (directory instanceof Error) return interaction.editReply({ content: directory.message })
    const files = [...interaction.fields.getUploadedFiles('files', true).values()]
    if (files.length < 1 || files.length > (prompt.maxFiles ?? 5)) return interaction.editReply({ content: 'Too many files' })
    const output = path.join(directory, 'uploads', id)
    const created = await fs.promises
      .mkdir(output, { recursive: true })
      .catch((cause) => new DiscordError({ operation: 'create upload directory', cause }))
    if (created instanceof Error) return interaction.editReply({ content: created.message })
    const paths: string[] = []
    for (const [index, file] of files.entries()) {
      const signal = AbortSignal.any([pending.controller.signal, AbortSignal.timeout(30000)])
      const response = await fetch(file.url, { signal }).catch((cause) => new DiscordError({ operation: 'download upload', cause }))
      if (!active()) return interaction.editReply({ content: 'Upload cancelled' })
      if (response instanceof Error || !response.ok) return interaction.editReply({ content: 'Upload download failed. Try again.' })
      const bytes = await response.arrayBuffer().catch((cause) => new DiscordError({ operation: 'read upload', cause }))
      if (!active()) return interaction.editReply({ content: 'Upload cancelled' })
      if (bytes instanceof Error) return interaction.editReply({ content: bytes.message })
      const destination = path.join(output, `${index}-${path.basename(file.name)}`)
      const written = await fs.promises
        .writeFile(destination, Buffer.from(bytes), { signal: pending.controller.signal })
        .catch((cause) => new DiscordError({ operation: 'save upload', cause }))
      if (!active()) return interaction.editReply({ content: 'Upload cancelled' })
      if (written instanceof Error) return interaction.editReply({ content: written.message })
      paths.push(destination)
    }
    uploads.delete(id)
    clearTimeout(pending.timer)
    pending.resolve({ paths })
    bot.eventLoop.dispatch(threadId, { type: 'kimaki.agent-ui-dismiss', id })
    return interaction.editReply({ content: `Uploaded ${paths.length} file(s)` })
  }

  return {
    request,
    submitUpload,
    stop() {
      unsubscribe()
      for (const pending of uploads.values()) cancelUpload(pending)
      uploads.clear()
    },
  }
}

// Buttons of an agent prompt: an action button sends `User clicked: <label>`; the
// upload button opens the file modal.
async function clickAgentButton(bot: Bot, interaction: ButtonInteraction) {
  const [, id = '', index = '0'] = interaction.customId.split(':')
  const prompt = shownPrompt(bot, { id, threadId: interaction.channelId })
  if (!prompt) return interaction.reply({ content: 'This request has expired', flags: MessageFlags.Ephemeral })
  if (!prompt.buttons) {
    const files = new FileUploadBuilder().setCustomId('files').setMinValues(1).setMaxValues(prompt.maxFiles ?? 5).setRequired(true)
    const modal = new ModalBuilder()
      .setCustomId(`file_upload_modal:${id}`)
      .setTitle('Upload files')
      .addLabelComponents(new LabelBuilder().setLabel('Files').setFileUploadComponent(files))
    return interaction.showModal(modal)
  }
  await interaction.deferUpdate()
  const item = prompt.buttons[Number(index)]
  if (!item) return
  bot.eventLoop.dispatch(interaction.channelId, { type: 'kimaki.agent-ui-dismiss', id })
  const result = await send(bot, { threadId: interaction.channelId, prompt: `User clicked: ${item.label}`, user: [interaction.user.id] })
  if (result instanceof Error) await interaction.followUp({ content: result.message, flags: MessageFlags.Ephemeral })
}

export const agentUiRoutes: InteractionRoutes = {
  buttons: { 'action_button:': clickAgentButton, 'file_upload_btn:': clickAgentButton },
  modals: { 'file_upload_modal:': (bot, interaction) => bot.features.agentUi.submitUpload(interaction) },
}
