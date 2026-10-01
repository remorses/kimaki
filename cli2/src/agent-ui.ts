import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ButtonStyle, FileUploadBuilder, LabelBuilder, ModalBuilder, MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js'
import type { Actions } from './actions.ts'
import { ConfigError, DiscordError } from './errors.ts'
import { button, buttonRow, textOnly } from './effects.ts'
import type { EventLoop } from './event-loop.ts'
import type { BotStore } from './store.ts'
import type { ThreadEvent, ThreadView, Effect } from './thread-reducer.ts'

export type AgentButton = { label: string; command?: string; color: 'white' | 'blue' | 'green' | 'red' }
export type AgentPrompt = { id: string; sessionId: string; buttons?: AgentButton[]; prompt?: string; maxFiles?: number }
export type AgentUiEvent = { type: 'kimaki.agent-ui'; prompt: AgentPrompt } | { type: 'kimaki.agent-ui-dismiss'; id: string }
const styles = { white: ButtonStyle.Secondary, blue: ButtonStyle.Primary, green: ButtonStyle.Success, red: ButtonStyle.Danger } as const

export function parseButton(value: string): ConfigError | AgentButton {
  const match = value.match(/:(white|blue|green|red)$/)
  const color = match?.[1] ?? 'white'
  const body = match ? value.slice(0, -match[0].length) : value
  const equal = body.indexOf('=')
  const label = equal < 0 ? body : body.slice(0, equal)
  if (!label.trim() || label.length > 80) return new ConfigError({ reason: 'Button labels must have 1 to 80 characters' })
  const command = equal < 0 ? undefined : body.slice(equal + 1)
  if (command !== undefined && !command.trim()) return new ConfigError({ reason: 'Button command must not be empty' })
  if (color !== 'white' && color !== 'blue' && color !== 'green' && color !== 'red') return new ConfigError({ reason: 'Unknown button color' })
  return { label, color, ...(command && { command }) }
}

export function reduceAgentUi(view: ThreadView, event: ThreadEvent): { view: ThreadView; effects: Effect[] } | null {
  const dismiss = (ids: string[]) => ({ view: { ...view, agentUi: view.agentUi.filter((prompt) => !ids.includes(prompt.id)) }, effects: ids.map((id): Effect => ({ type: 'edit', key: `agent:${id}`, messages: [textOnly('Dismissed')] })) })
  if (event.type === 'kimaki.agent-ui-dismiss') return dismiss([event.id])
  if (event.type === 'session.inbox.enqueued' && event.data.item.type === 'user' && view.agentUi.length > 0) return dismiss(view.agentUi.filter((prompt) => prompt.sessionId === event.data.sessionID).map((prompt) => prompt.id))
  if (event.type !== 'kimaki.agent-ui') return null
  const prompt = event.prompt
  const buttons = prompt.buttons?.map((item, index) => button({ customId: `action_button:${prompt.id}:${index}`, label: item.label, style: styles[item.color] }))
    ?? [button({ customId: `file_upload_btn:${prompt.id}`, label: 'Upload files' })]
  const commands = prompt.buttons?.flatMap((item) => item.command ? [`${item.label}: \`${item.command}\``] : []) ?? []
  return { view: { ...view, agentUi: [...view.agentUi, prompt] }, effects: [{ type: 'show', key: `agent:${prompt.id}`, replyTo: null,
    messages: [{ content: prompt.prompt ?? commands.join('\n'), components: [buttonRow(buttons)] }] }] }
}

export function createAgentUi({ store, eventLoop, actions, directoryFor }: {
  store: BotStore; eventLoop: EventLoop; actions: Actions; directoryFor: (sessionId: string) => Promise<Error | string>
}) {
  const uploads = new Map<string, { resolve: (value: { paths: string[] } | { cancelled: true }) => void; timer: ReturnType<typeof setTimeout>; controller: AbortController }>()
  const unsubscribe = store.subscribe((state, previous) => {
    for (const [id, pending] of uploads) {
      if (!Object.values(previous.threads).some((view) => view.agentUi.some((prompt) => prompt.id === id))) continue
      if (Object.values(state.threads).some((view) => view.agentUi.some((prompt) => prompt.id === id))) continue
      clearTimeout(pending.timer)
      pending.controller.abort()
      pending.resolve({ cancelled: true })
      uploads.delete(id)
    }
  })
  async function waitForShellCall({ sessionId, toolCall, signal }: { sessionId: string; toolCall: string; signal: AbortSignal }): Promise<ConfigError | void> {
    const seen = () => Object.values(store.getState().threads).some((view) => view.shellCalls[toolCall]?.sessionId === sessionId)
    if (seen()) return
    return new Promise((resolve) => {
      const finish = (value?: ConfigError) => { clearTimeout(timer); off(); signal.removeEventListener('abort', abort); resolve(value) }
      const off = store.subscribe(() => { if (seen()) finish() })
      const abort = () => finish(new ConfigError({ reason: 'Agent UI request cancelled' }))
      const timer = setTimeout(() => finish(new ConfigError({ reason: 'No running shell call observed. Run this command from the session shell.' })), 10_000)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else if (seen()) finish()
    })
  }
  async function request(route: string, input: unknown, signal: AbortSignal): Promise<Error | { data: unknown }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return new ConfigError({ reason: 'Expected agent UI input' })
    const fields = new Map(Object.entries(input))
    const sessionId = fields.get('sessionId')
    if (typeof sessionId !== 'string' || !sessionId) return new ConfigError({ reason: 'Use --session or run inside an OpenCode session' })
    const threadId = store.getState().sessionThreads[sessionId]
    if (!threadId) return new ConfigError({ reason: 'This session has no local Discord thread' })
    const id = crypto.randomBytes(8).toString('hex')
    const prompt: AgentPrompt = { id, sessionId }
    if (route === '/kimaki/buttons') {
      const specs = fields.get('buttons')
      if (!Array.isArray(specs) || specs.length < 1 || specs.length > 3 || specs.some((spec) => typeof spec !== 'string')) return new ConfigError({ reason: 'Use 1 to 3 --button flags' })
      const buttons: AgentButton[] = []
      for (const spec of specs) {
        const parsed = parseButton(spec)
        if (parsed instanceof Error) return parsed
        buttons.push(parsed)
      }
      if (buttons.map((item) => item.command ?? '').join('\n').length > 1800) return new ConfigError({ reason: 'Button commands must fit in one Discord message' })
      prompt.buttons = buttons
    } else {
      const text = fields.get('prompt')
      const maxFiles = fields.get('maxFiles') ?? 5
      if (typeof text !== 'string' || !text || text.length > 2000 || typeof maxFiles !== 'number' || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10) return new ConfigError({ reason: 'Use --prompt and --max-files 1 to 10' })
      prompt.prompt = text
      prompt.maxFiles = maxFiles
    }
    if (fields.get('fromShell') === true) {
      const toolCall = fields.get('toolCall')
      if (typeof toolCall !== 'string' || !toolCall) return new ConfigError({ reason: 'The Kimaki plugin must provide KIMAKI_TOOL_CALL for agent UI commands' })
      const waited = await waitForShellCall({ sessionId, toolCall, signal })
      if (waited instanceof Error) return waited
    }
    eventLoop.dispatch(threadId, { type: 'kimaki.agent-ui', prompt })
    if (prompt.buttons) return { data: { shown: true } }
    const result = await new Promise<{ paths: string[] } | { cancelled: true }>((resolve) => {
      const finish = (value: { paths: string[] } | { cancelled: true }) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      }
      const abort = () => { eventLoop.dispatch(threadId, { type: 'kimaki.agent-ui-dismiss', id }); finish({ cancelled: true }) }
      const timer = setTimeout(abort, 6 * 60_000)
      uploads.set(id, { resolve: finish, timer, controller: new AbortController() })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    return { data: result }
  }
  function find(id: string, threadId: string) {
    return store.getState().threads[threadId]?.agentUi.find((prompt) => prompt.id === id)
  }
  async function click(interaction: ButtonInteraction) {
    const [, id = '', index = '0'] = interaction.customId.split(':')
    const prompt = find(id, interaction.channelId)
    if (!prompt) return interaction.reply({ content: 'This request has expired', flags: MessageFlags.Ephemeral })
    if (!prompt.buttons) {
      return interaction.showModal(new ModalBuilder().setCustomId(`file_upload_modal:${id}`).setTitle('Upload files').addLabelComponents(
        new LabelBuilder().setLabel('Files').setFileUploadComponent(new FileUploadBuilder().setCustomId('files').setMinValues(1).setMaxValues(prompt.maxFiles ?? 5).setRequired(true)),
      ))
    }
    await interaction.deferUpdate()
    const item = prompt.buttons[Number(index)]
    if (!item) return
    eventLoop.dispatch(interaction.channelId, { type: 'kimaki.agent-ui-dismiss', id })
    const result = await actions.send({ threadId: interaction.channelId, prompt: item.command ? `!${item.command}` : `User clicked: ${item.label}`, user: interaction.user.id })
    if (result instanceof Error) await interaction.followUp({ content: result.message, flags: MessageFlags.Ephemeral })
  }
  async function modal(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    if (!interaction.channelId) return interaction.editReply({ content: 'Use this upload in its session thread' })
    const id = interaction.customId.split(':')[1] ?? ''
    const prompt = find(id, interaction.channelId)
    const pending = uploads.get(id)
    if (!prompt || !pending) return interaction.editReply({ content: 'Upload request expired' })
    const active = () => uploads.get(id) === pending && !pending.controller.signal.aborted
    const directory = await directoryFor(prompt.sessionId)
    if (!active()) return interaction.editReply({ content: 'Upload cancelled' })
    if (directory instanceof Error) return interaction.editReply({ content: directory.message })
    const files = [...interaction.fields.getUploadedFiles('files', true).values()]
    if (files.length < 1 || files.length > (prompt.maxFiles ?? 5)) return interaction.editReply({ content: 'Too many files' })
    const output = path.join(directory, 'uploads', id)
    const created = await fs.promises.mkdir(output, { recursive: true }).catch((cause) => new DiscordError({ operation: 'create upload directory', cause }))
    if (created instanceof Error) return interaction.editReply({ content: created.message })
    const paths: string[] = []
    for (const [index, file] of files.entries()) {
      const response = await fetch(file.url, { signal: AbortSignal.any([pending.controller.signal, AbortSignal.timeout(30000)]) }).catch((cause) => new DiscordError({ operation: 'download upload', cause }))
      if (!active()) return interaction.editReply({ content: 'Upload cancelled' })
      if (response instanceof Error || !response.ok) return interaction.editReply({ content: 'Upload download failed. Try again.' })
      const bytes = await response.arrayBuffer().catch((cause) => new DiscordError({ operation: 'read upload', cause }))
      if (!active()) return interaction.editReply({ content: 'Upload cancelled' })
      if (bytes instanceof Error) return interaction.editReply({ content: bytes.message })
      const destination = path.join(output, `${index}-${path.basename(file.name)}`)
      const written = await fs.promises.writeFile(destination, Buffer.from(bytes), { signal: pending.controller.signal }).catch((cause) => new DiscordError({ operation: 'save upload', cause }))
      if (!active()) return interaction.editReply({ content: 'Upload cancelled' })
      if (written instanceof Error) return interaction.editReply({ content: written.message })
      paths.push(destination)
    }
    uploads.delete(id)
    clearTimeout(pending.timer)
    pending.resolve({ paths })
    eventLoop.dispatch(interaction.channelId, { type: 'kimaki.agent-ui-dismiss', id })
    return interaction.editReply({ content: `Uploaded ${paths.length} file(s)` })
  }
  return { request, click, modal, stop() { unsubscribe(); for (const pending of uploads.values()) { clearTimeout(pending.timer); pending.controller.abort(); pending.resolve({ cancelled: true }) }; uploads.clear() } }
}

export type AgentUi = ReturnType<typeof createAgentUi>
