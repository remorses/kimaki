// Claude Code session manager: one live Agent SDK query per active session,
// translated onto OpenCode's wire protocol.
//
// Each ClaudeCodeSession owns:
//  - the OpenCode Session wire object (what session.get returns)
//  - the message/part store (what session.messages returns)
//  - an optional live query() in streaming-input mode (the running agent)
//  - pending permission/question bridges for Discord button round-trips
//
// The manager keeps the registry, persists session metadata to disk so
// threads survive bot restarts (transcripts themselves are persisted by
// Claude Code under ~/.claude), and fans out OpenCode events to the router's
// SSE subscribers.

import fs from 'node:fs'
import path from 'node:path'
import {
  query as sdkQuery,
  getSessionInfo,
  getSessionMessages,
  AbortError,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKResultMessage,
  type SDKAssistantMessage,
  type PermissionResult,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  Event as OpenCodeEvent,
  Message,
  Part,
  PermissionRuleset,
  QuestionAnswer,
  QuestionInfo,
  Session,
  SessionStatus,
  TextPartInput,
  FilePartInput,
  TextPart,
  ToolPart,
  ReasoningPart,
  StepFinishPart,
  SnapshotFileDiff,
  AssistantMessage,
} from '@opencode-ai/sdk/v2'
import { createLogger, LogPrefix } from '../logger.js'
import { getDataDir } from '../config.js'
import { execAsync } from '../exec-async.js'
import {
  createClaudeEventId,
  createClaudeMessageId,
  createClaudePartId,
  createClaudePermissionId,
  createClaudeQuestionId,
  createClaudeSessionId,
} from './ids.js'
import { buildAlwaysRules, describeToolPermission, evaluatePermission } from './permission-map.js'
import {
  asRecord,
  buildAssistantInfo,
  buildQuestionAnswersInput,
  buildUserContent,
  extractToolResults,
  mapAskUserQuestions,
  normalizeToolName,
  translateAssistantBlock,
  translateTranscriptMessages,
  type AssistantContentBlock,
} from './translate.js'
import { CLAUDE_CODE_PROVIDER_ID, DEFAULT_CLAUDE_MODEL_ID, updateLiveModels } from './models.js'
import { createKimakiMcpServer } from './kimaki-mcp.js'

const logger = createLogger(LogPrefix.SESSION)

const PART_FLUSH_INTERVAL_MS = 400

// Idle sessions release their Claude Code subprocess after this long; the
// next prompt resumes seamlessly from the persisted transcript (~/.claude).
const IDLE_SUBPROCESS_REAP_MS = 10 * 60 * 1000

export type ClaudeEventSink = (directory: string, event: OpenCodeEvent) => void

export type QueryImpl = typeof sdkQuery

export type PromptRequest = {
  parts: Array<TextPartInput | FilePartInput>
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
  system?: string
  noReply?: boolean
}

type PushQueue<T> = {
  iterable: AsyncIterable<T>
  push: (value: T) => void
  end: () => void
}

function createPushQueue<T>(): PushQueue<T> {
  const values: T[] = []
  let notify: (() => void) | null = null
  let ended = false
  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          while (true) {
            const value = values.shift()
            if (value !== undefined) {
              return { value, done: false }
            }
            if (ended) {
              return { value: undefined, done: true }
            }
            await new Promise<void>((resolve) => {
              notify = resolve
            })
          }
        },
      }
    },
  }
  return {
    iterable,
    push(value: T) {
      values.push(value)
      notify?.()
      notify = null
    },
    end() {
      ended = true
      notify?.()
      notify = null
    },
  }
}

type LiveConfig = {
  model?: string
  variant?: string
  agent?: string
  system?: string
}

type LiveQueryHandle = {
  query: Query
  input: PushQueue<SDKUserMessage>
  config: LiveConfig
  abortController: AbortController
  done: Promise<void>
  stderrTail: string[]
}

type PendingPermission = {
  sessionId: string
  resolve: (result: PermissionResult) => void
  input: Record<string, unknown>
  permission: string
  always: string[]
}

type PendingQuestion = {
  sessionId: string
  resolve: (result: PermissionResult) => void
  questions: QuestionInfo[]
  originalInput: Record<string, unknown>
}

type PersistedSessionState = {
  id: string
  directory: string
  sdkSessionId?: string
  title: string
  permission: PermissionRuleset
  parentID?: string
  agent?: string
  timeCreated: number
}

type StreamingPartState = {
  part: TextPart | ReasoningPart | ToolPart
  rawInput?: string
  flushTimer?: ReturnType<typeof setTimeout>
  dirty: boolean
}

function persistenceDir(): string {
  return path.join(getDataDir(), 'claude-code', 'sessions')
}

function persistenceFile(sessionId: string): string {
  return path.join(persistenceDir(), `${sessionId}.json`)
}

export class ClaudeCodeSession {
  readonly id: string
  readonly directory: string
  session: Session
  private readonly manager: ClaudeCodeSessionManager
  private messageOrder: string[] = []
  private messages = new Map<string, { info: Message; parts: Map<string, Part> }>()
  private status: SessionStatus = { type: 'idle' }
  private live: LiveQueryHandle | null = null
  private sdkSessionId: string | undefined
  private pendingFork: { resumeSessionAt?: string } | null = null
  private uuidByMessageId = new Map<string, string>()
  private toolPartsByCallId = new Map<string, ToolPart>()
  private streamingParts = new Map<string, StreamingPartState>()
  private currentAssistantMessageId: string | null = null
  private lastUserMessageId = ''
  private currentModelId = DEFAULT_CLAUDE_MODEL_ID
  private abortRequested = false
  private lastAssistantError: SDKAssistantMessage['error'] | undefined
  private seenSdkUuids = new Set<string>()
  private hydrated = false
  private disposed = false

  constructor({
    manager,
    id,
    directory,
    permission,
    title,
    parentID,
    sdkSessionId,
    timeCreated,
    agent,
  }: {
    manager: ClaudeCodeSessionManager
    id: string
    directory: string
    permission: PermissionRuleset
    title?: string
    parentID?: string
    sdkSessionId?: string
    timeCreated?: number
    agent?: string
  }) {
    this.manager = manager
    this.id = id
    this.directory = directory
    this.sdkSessionId = sdkSessionId
    const created = timeCreated ?? Date.now()
    this.session = {
      id,
      slug: id,
      projectID: CLAUDE_CODE_PROVIDER_ID,
      directory,
      title: title || 'New Claude Code session',
      version: '',
      time: { created, updated: created },
      permission,
      ...(parentID ? { parentID } : {}),
      ...(agent ? { agent } : {}),
    }
  }

  // ── Wire accessors ────────────────────────────────────────────

  toWire(): Session {
    return this.session
  }

  getStatus(): SessionStatus {
    return this.status
  }

  async messagesWire(): Promise<Array<{ info: Message; parts: Part[] }>> {
    await this.hydrateFromTranscript()
    return this.messageOrder.flatMap((messageId) => {
      const entry = this.messages.get(messageId)
      if (!entry) {
        return []
      }
      return [{ info: entry.info, parts: [...entry.parts.values()] }]
    })
  }

  /**
   * After a bot restart the in-memory store is empty but the Claude Code
   * transcript persists under ~/.claude. Rebuild the wire messages once on
   * first access so /resume and session.messages keep working.
   */
  private async hydrateFromTranscript(): Promise<void> {
    if (this.hydrated || this.messages.size > 0 || !this.sdkSessionId) {
      this.hydrated = true
      return
    }
    this.hydrated = true
    const transcript = await getSessionMessages(this.sdkSessionId, {
      dir: this.directory,
    }).catch((error) => {
      logger.warn(
        `[CLAUDE] Failed to hydrate transcript for ${this.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    })
    if (transcript.length === 0) {
      return
    }
    const { messages, uuidByMessageId } = translateTranscriptMessages({
      transcript,
      sessionId: this.id,
      directory: this.directory,
      agent: this.session.agent ?? 'claude',
    })
    for (const entry of messages) {
      const parts = new Map<string, Part>()
      for (const part of entry.parts) {
        parts.set(part.id, part)
        if (part.type === 'tool') {
          this.toolPartsByCallId.set(part.callID, part)
        }
      }
      this.messages.set(entry.info.id, { info: entry.info, parts })
      this.messageOrder.push(entry.info.id)
      if (entry.info.role === 'user') {
        this.lastUserMessageId = entry.info.id
      }
    }
    for (const [messageId, uuid] of uuidByMessageId) {
      this.uuidByMessageId.set(messageId, uuid)
    }
  }

  // ── Event helpers ─────────────────────────────────────────────

  private emit(event: OpenCodeEvent): void {
    this.manager.emitEvent(this.directory, event)
  }

  private emitSessionUpdated(): void {
    this.session.time.updated = Date.now()
    this.emit({
      id: createClaudeEventId(),
      type: 'session.updated',
      properties: { sessionID: this.id, info: this.session },
    })
  }

  private idleReapTimer: ReturnType<typeof setTimeout> | undefined

  private setStatus(status: SessionStatus): void {
    this.status = status
    this.emit({
      id: createClaudeEventId(),
      type: 'session.status',
      properties: { sessionID: this.id, status },
    })
    if (this.idleReapTimer) {
      clearTimeout(this.idleReapTimer)
      this.idleReapTimer = undefined
    }
    if (status.type === 'idle') {
      this.emit({
        id: createClaudeEventId(),
        type: 'session.idle',
        properties: { sessionID: this.id },
      })
      this.idleReapTimer = setTimeout(() => {
        this.idleReapTimer = undefined
        if (this.status.type !== 'idle' || !this.live) {
          return
        }
        logger.log(`[CLAUDE] Releasing idle subprocess for session ${this.id}`)
        void this.closeLive()
      }, IDLE_SUBPROCESS_REAP_MS)
      this.idleReapTimer.unref?.()
    }
  }

  private emitMessageUpdated(info: Message): void {
    this.emit({
      id: createClaudeEventId(),
      type: 'message.updated',
      properties: { sessionID: this.id, info },
    })
  }

  private emitPartUpdated(part: Part): void {
    this.emit({
      id: createClaudeEventId(),
      type: 'message.part.updated',
      properties: { sessionID: this.id, part, time: Date.now() },
    })
  }

  private storeMessage(info: Message): void {
    if (!this.messages.has(info.id)) {
      this.messages.set(info.id, { info, parts: new Map() })
      this.messageOrder.push(info.id)
    } else {
      const existing = this.messages.get(info.id)!
      existing.info = info
    }
  }

  private storePart(part: Part): void {
    const entry = this.messages.get(part.messageID)
    if (entry) {
      entry.parts.set(part.id, part)
    }
    if (part.type === 'tool') {
      this.toolPartsByCallId.set(part.callID, part)
    }
  }

  // ── Prompting ─────────────────────────────────────────────────

  async prompt(request: PromptRequest): Promise<void> {
    if (this.disposed) {
      throw new Error(`Session ${this.id} has been deleted`)
    }
    const hasContent = request.parts.some((part) => {
      return part.type === 'file' || part.text.trim().length > 0
    })
    if (!hasContent) {
      // OpenCode uses empty prompts to nudge a blocked loop; the Claude
      // backend resumes automatically after permission replies, so this is
      // a no-op.
      return
    }
    await this.hydrateFromTranscript()

    const modelId =
      request.model && request.model.providerID === CLAUDE_CODE_PROVIDER_ID
        ? request.model.modelID
        : undefined
    if (modelId) {
      this.currentModelId = modelId
    }

    // Kimaki channel/session agent preferences name opencode agents (build,
    // plan, custom .md agents). Only pass an agent through when Claude Code
    // reported it during init; unknown names would fail the whole query.
    const knownAgents = this.manager.getAgents(this.directory)
    const validatedAgent =
      request.agent && knownAgents.includes(request.agent) ? request.agent : undefined
    if (request.agent && !validatedAgent) {
      logger.log(
        `[CLAUDE] Ignoring agent "${request.agent}" — not a Claude Code agent in ${this.directory}`,
      )
    }

    const desired: LiveConfig = {
      model: this.currentModelId,
      variant: request.variant,
      agent: validatedAgent,
      system: request.system,
    }

    const live = await this.ensureLive(desired)

    // Record the user message in the wire store (visible prompt parts only).
    const userMessageId = createClaudeMessageId()
    this.lastUserMessageId = userMessageId
    const userInfo: Message = {
      id: userMessageId,
      sessionID: this.id,
      role: 'user',
      time: { created: Date.now() },
      agent: validatedAgent ?? this.session.agent ?? 'claude',
      model: {
        providerID: CLAUDE_CODE_PROVIDER_ID,
        modelID: this.currentModelId,
        ...(request.variant ? { variant: request.variant } : {}),
      },
    }
    this.storeMessage(userInfo)
    for (const part of request.parts) {
      if (part.type === 'text' && part.text.trim().length === 0) {
        continue
      }
      const wirePart: Part =
        part.type === 'text'
          ? {
              id: createClaudePartId(),
              sessionID: this.id,
              messageID: userMessageId,
              type: 'text',
              text: part.text,
              ...(part.synthetic ? { synthetic: true } : {}),
              time: { start: Date.now(), end: Date.now() },
            }
          : {
              id: createClaudePartId(),
              sessionID: this.id,
              messageID: userMessageId,
              type: 'file',
              mime: part.mime,
              url: part.url,
              ...(part.filename ? { filename: part.filename } : {}),
            }
      this.storePart(wirePart)
    }
    this.emitMessageUpdated(userInfo)
    const userParts = this.messages.get(userMessageId)
    if (userParts) {
      for (const part of userParts.parts.values()) {
        this.emitPartUpdated(part)
      }
    }

    const content = buildUserContent({ parts: request.parts })
    if (content.length === 0) {
      return
    }
    const shouldQuery = request.noReply !== true
    live.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      ...(shouldQuery ? {} : { shouldQuery: false }),
    })

    if (shouldQuery) {
      this.abortRequested = false
      this.setStatus({ type: 'busy' })
    }
  }

  /** Push a raw text command (e.g. "/compact") without a visible wire message. */
  async pushHiddenCommand(command: string): Promise<void> {
    const live = await this.ensureLive({
      model: this.currentModelId,
    })
    live.input.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: command }] },
      parent_tool_use_id: null,
    })
    this.abortRequested = false
    this.setStatus({ type: 'busy' })
  }

  private async ensureLive(desired: LiveConfig): Promise<LiveQueryHandle> {
    const existing = this.live
    if (existing) {
      const needsRestart =
        (desired.agent !== undefined && desired.agent !== existing.config.agent) ||
        (desired.variant !== undefined && desired.variant !== existing.config.variant) ||
        (desired.system !== undefined && desired.system !== existing.config.system)
      if (!needsRestart) {
        if (desired.model && desired.model !== existing.config.model) {
          existing.config.model = desired.model
          await existing.query.setModel(desired.model).catch((error) => {
            logger.warn(
              `[CLAUDE] setModel(${desired.model}) failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          })
        }
        return existing
      }
      if (this.status.type === 'busy') {
        // Config changes can't be applied mid-turn; keep the current query.
        logger.log(`[CLAUDE] Deferring agent/variant/system change for busy session ${this.id}`)
        return existing
      }
      await this.closeLive()
    }
    return this.startLive(desired)
  }

  private async closeLive(): Promise<void> {
    const live = this.live
    if (!live) {
      return
    }
    this.live = null
    live.input.end()
    const closeResult = await Promise.race([
      live.done.then(() => {
        return 'done' as const
      }),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout')
        }, 3000).unref()
      }),
    ]).catch(() => {
      return 'error' as const
    })
    if (closeResult !== 'done') {
      live.abortController.abort()
    }
  }

  private startLive(desired: LiveConfig): LiveQueryHandle {
    const input = createPushQueue<SDKUserMessage>()
    const abortController = new AbortController()
    const stderrTail: string[] = []

    const options: Options = {
      cwd: this.directory,
      model: desired.model ?? this.currentModelId,
      permissionMode: 'default',
      includePartialMessages: true,
      enableFileCheckpointing: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(desired.system ? { append: desired.system } : {}),
      },
      mcpServers: {
        kimaki: createKimakiMcpServer({
          sessionId: this.id,
          directory: this.directory,
        }),
      },
      abortController,
      stderr: (data: string) => {
        stderrTail.push(data)
        if (stderrTail.length > 20) {
          stderrTail.shift()
        }
      },
      canUseTool: async (toolName, toolInput, callOptions) => {
        return this.handleCanUseTool({
          toolName,
          input: toolInput,
          signal: callOptions.signal,
          toolUseID: callOptions.toolUseID,
          blockedPath: callOptions.blockedPath,
        })
      },
      ...(desired.agent ? { agent: desired.agent } : {}),
      ...(desired.variant && isEffortLevel(desired.variant) ? { effort: desired.variant } : {}),
      ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
      ...(this.pendingFork
        ? {
            forkSession: true,
            ...(this.pendingFork.resumeSessionAt
              ? { resumeSessionAt: this.pendingFork.resumeSessionAt }
              : {}),
          }
        : {}),
    }
    this.pendingFork = null

    const q = this.manager.queryImpl({ prompt: input.iterable, options })
    const handle: LiveQueryHandle = {
      query: q,
      input,
      config: { ...desired, model: options.model },
      abortController,
      done: Promise.resolve(),
      stderrTail,
    }
    handle.done = this.pumpQuery(handle)
    this.live = handle
    return handle
  }

  private async pumpQuery(handle: LiveQueryHandle): Promise<void> {
    const pumpResult = await (async () => {
      for await (const message of handle.query) {
        this.handleSdkMessage(message)
      }
    })().catch((error: unknown) => {
      return error
    })

    const wasCurrent = this.live === handle
    if (wasCurrent) {
      this.live = null
    }

    if (pumpResult instanceof Error && !(pumpResult instanceof AbortError)) {
      logger.error(
        `[CLAUDE] Query pump failed for ${this.id}: ${pumpResult.message}\n${handle.stderrTail.join('')}`,
      )
      if (wasCurrent && !this.disposed) {
        this.emit({
          id: createClaudeEventId(),
          type: 'session.error',
          properties: {
            sessionID: this.id,
            error: {
              name: 'UnknownError',
              data: {
                message: buildQueryErrorMessage({
                  error: pumpResult,
                  stderrTail: handle.stderrTail,
                }),
              },
            },
          },
        })
      }
    }
    if (wasCurrent && this.status.type === 'busy' && !this.disposed) {
      this.finalizeOpenAssistantMessage({ aborted: true })
      this.setStatus({ type: 'idle' })
    }
  }

  // ── SDK message handling ──────────────────────────────────────

  private handleSdkMessage(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      this.sdkSessionId = message.session_id
      this.currentModelId = message.model
      this.manager.recordRuntimeInfo({
        directory: this.directory,
        slashCommands: message.slash_commands,
        agents: message.agents ?? [],
      })
      this.manager.persistSession(this)
      void this.refreshModelCatalog()
      return
    }
    if (message.type === 'stream_event') {
      if (message.parent_tool_use_id) {
        return
      }
      this.handleStreamEvent(message.event)
      return
    }
    if (message.type === 'assistant') {
      if (message.parent_tool_use_id) {
        return
      }
      this.reconcileAssistantMessage(message)
      return
    }
    if (message.type === 'user') {
      const uuid = typeof message.uuid === 'string' ? message.uuid : undefined
      if (uuid) {
        if (this.seenSdkUuids.has(uuid)) {
          return
        }
        this.seenSdkUuids.add(uuid)
      }
      if (message.parent_tool_use_id) {
        return
      }
      for (const result of extractToolResults(message.message)) {
        this.applyToolResult(result)
      }
      return
    }
    if (message.type === 'result') {
      this.handleResult(message)
      return
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      this.handleCompactBoundary(message.compact_metadata.trigger === 'auto')
      return
    }
    if (message.type === 'system' && message.subtype === 'session_state_changed') {
      // Safety net: authoritative idle signal in case a result was missed.
      if (message.state === 'idle' && this.status.type === 'busy') {
        this.setStatus({ type: 'idle' })
      }
      return
    }
  }

  private async refreshModelCatalog(): Promise<void> {
    const live = this.live
    if (!live || this.manager.modelCatalogLoaded) {
      return
    }
    const models = await live.query.supportedModels().catch((error) => {
      logger.warn(
        `[CLAUDE] supportedModels failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    })
    if (models.length > 0) {
      // Latch only on success so a failed first attempt retries on the next
      // session init; the static catalog covers the gap.
      this.manager.modelCatalogLoaded = true
    }
    updateLiveModels(models)
    const commands = await live.query.supportedCommands().catch(() => {
      return [] as SlashCommand[]
    })
    if (commands.length > 0) {
      this.manager.recordSlashCommandDetails(this.directory, commands)
    }
  }

  private ensureAssistantMessage(): { info: AssistantMessage; parts: Map<string, Part> } {
    // A queued follow-up message starts a new SDK turn without going through
    // prompt(); mark the session busy as soon as assistant activity appears.
    if (this.status.type !== 'busy') {
      this.setStatus({ type: 'busy' })
    }
    if (this.currentAssistantMessageId) {
      const existing = this.messages.get(this.currentAssistantMessageId)
      if (existing && existing.info.role === 'assistant') {
        return existing as { info: AssistantMessage; parts: Map<string, Part> }
      }
    }
    const messageId = createClaudeMessageId()
    this.currentAssistantMessageId = messageId
    const info = buildAssistantInfo({
      sessionId: this.id,
      messageId,
      parentUserMessageId: this.lastUserMessageId,
      modelId: this.currentModelId,
      directory: this.directory,
      agent: this.session.agent ?? 'claude',
      created: Date.now(),
    })
    this.storeMessage(info)
    this.emitMessageUpdated(info)
    return this.messages.get(messageId) as {
      info: AssistantMessage
      parts: Map<string, Part>
    }
  }

  // Streaming events keyed by content block index within the current message.
  private streamKey(index: number): string {
    return `${this.currentAssistantMessageId ?? 'none'}:${index}`
  }

  private handleStreamEvent(event: Record<string, unknown> | { type: string }): void {
    const rec = asRecord(event)
    const type = rec.type
    if (type === 'message_start') {
      this.ensureAssistantMessage()
      return
    }
    if (type === 'content_block_start') {
      const index = typeof rec.index === 'number' ? rec.index : 0
      const contentBlock = asRecord(rec.content_block)
      const entry = this.ensureAssistantMessage()
      const now = Date.now()
      if (contentBlock.type === 'text') {
        const part: TextPart = {
          id: createClaudePartId(),
          sessionID: this.id,
          messageID: entry.info.id,
          type: 'text',
          text: '',
          time: { start: now },
        }
        this.streamingParts.set(this.streamKey(index), { part, dirty: false })
        this.storePart(part)
        return
      }
      if (contentBlock.type === 'thinking' || contentBlock.type === 'redacted_thinking') {
        const part: ReasoningPart = {
          id: createClaudePartId(),
          sessionID: this.id,
          messageID: entry.info.id,
          type: 'reasoning',
          text: '',
          time: { start: now },
        }
        this.streamingParts.set(this.streamKey(index), { part, dirty: false })
        this.storePart(part)
        return
      }
      if (contentBlock.type === 'tool_use') {
        const part: ToolPart = {
          id: createClaudePartId(),
          sessionID: this.id,
          messageID: entry.info.id,
          type: 'tool',
          callID: typeof contentBlock.id === 'string' ? contentBlock.id : createClaudePartId(),
          tool: normalizeToolName(
            typeof contentBlock.name === 'string' ? contentBlock.name : 'tool',
          ),
          state: { status: 'pending', input: {}, raw: '' },
        }
        this.streamingParts.set(this.streamKey(index), {
          part,
          rawInput: '',
          dirty: false,
        })
        this.storePart(part)
        this.emitPartUpdated(part)
        return
      }
      return
    }
    if (type === 'content_block_delta') {
      const index = typeof rec.index === 'number' ? rec.index : 0
      const state = this.streamingParts.get(this.streamKey(index))
      if (!state) {
        return
      }
      const delta = asRecord(rec.delta)
      if (delta.type === 'text_delta' && state.part.type === 'text') {
        state.part.text += typeof delta.text === 'string' ? delta.text : ''
        this.schedulePartFlush(state)
        return
      }
      if (delta.type === 'thinking_delta' && state.part.type === 'reasoning') {
        state.part.text += typeof delta.thinking === 'string' ? delta.thinking : ''
        this.schedulePartFlush(state)
        return
      }
      if (delta.type === 'input_json_delta' && state.part.type === 'tool') {
        state.rawInput =
          (state.rawInput ?? '') +
          (typeof delta.partial_json === 'string' ? delta.partial_json : '')
        return
      }
      return
    }
    if (type === 'content_block_stop') {
      const index = typeof rec.index === 'number' ? rec.index : 0
      const key = this.streamKey(index)
      const state = this.streamingParts.get(key)
      if (!state) {
        return
      }
      this.streamingParts.delete(key)
      if (state.flushTimer) {
        clearTimeout(state.flushTimer)
      }
      const now = Date.now()
      if (state.part.type === 'text' || state.part.type === 'reasoning') {
        state.part.time = { start: state.part.time?.start ?? now, end: now }
        this.storePart(state.part)
        this.emitPartUpdated(state.part)
        return
      }
      if (state.part.type === 'tool') {
        const input = (() => {
          if (!state.rawInput) {
            return {}
          }
          const parsed = (() => {
            const tryParse = () => JSON.parse(state.rawInput!) as unknown
            return errToNull(tryParse)
          })()
          return asRecord(parsed)
        })()
        state.part.state = {
          status: 'running',
          input,
          title: state.part.tool,
          time: { start: now },
        }
        this.storePart(state.part)
        this.emitPartUpdated(state.part)
      }
      return
    }
  }

  private schedulePartFlush(state: StreamingPartState): void {
    state.dirty = true
    if (state.flushTimer) {
      return
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined
      if (!state.dirty) {
        return
      }
      state.dirty = false
      this.storePart(state.part)
      this.emitPartUpdated(state.part)
    }, PART_FLUSH_INTERVAL_MS)
    state.flushTimer.unref?.()
  }

  /**
   * The complete assistant SDK message is authoritative: reconcile parts so
   * missed stream deltas (or disabled partial streaming) still produce the
   * full content.
   */
  private reconcileAssistantMessage(message: SDKAssistantMessage): void {
    this.lastAssistantError = message.error
    const entry = this.ensureAssistantMessage()
    this.uuidByMessageId.set(entry.info.id, message.uuid)
    const model = message.message.model
    if (typeof model === 'string' && model.length > 0) {
      this.currentModelId = model
      entry.info.modelID = model
    }

    const existingParts = [...entry.parts.values()]
    const now = Date.now()
    for (const block of message.message.content) {
      if (block.type === 'text' || block.type === 'thinking') {
        const partType = block.type === 'text' ? 'text' : 'reasoning'
        const text = block.type === 'text' ? block.text : block.thinking
        const match = existingParts.find((part) => {
          return (
            part.type === partType &&
            (part as TextPart | ReasoningPart).text.length > 0 &&
            text.startsWith((part as TextPart | ReasoningPart).text.slice(0, 64))
          )
        })
        if (match && (match.type === 'text' || match.type === 'reasoning')) {
          if (match.text !== text) {
            match.text = text
            match.time = { start: match.time?.start ?? now, end: now }
            this.storePart(match)
            this.emitPartUpdated(match)
          }
          continue
        }
        if (text.trim().length === 0) {
          continue
        }
        const part = translateAssistantBlock({
          block,
          sessionId: this.id,
          messageId: entry.info.id,
          now,
        })
        if (part) {
          this.storePart(part)
          this.emitPartUpdated(part)
        }
        continue
      }
      if (block.type === 'tool_use') {
        const existing = this.toolPartsByCallId.get(block.id)
        if (existing) {
          if (existing.state.status === 'pending') {
            existing.state = {
              status: 'running',
              input: asRecord(block.input),
              title: existing.tool,
              time: { start: now },
            }
            this.storePart(existing)
            this.emitPartUpdated(existing)
          }
          continue
        }
        const part = translateAssistantBlock({
          block: block as AssistantContentBlock,
          sessionId: this.id,
          messageId: entry.info.id,
          now,
        })
        if (part) {
          this.storePart(part)
          this.emitPartUpdated(part)
        }
      }
    }
    this.emitMessageUpdated(entry.info)
  }

  private applyToolResult(result: { toolUseId: string; output: string; isError: boolean }): void {
    const part = this.toolPartsByCallId.get(result.toolUseId)
    if (!part) {
      return
    }
    const now = Date.now()
    const startTime = (() => {
      if (part.state.status === 'running') {
        return part.state.time.start
      }
      return now
    })()
    const input = part.state.input
    if (result.isError) {
      part.state = {
        status: 'error',
        input,
        error: result.output,
        time: { start: startTime, end: now },
      }
    } else {
      part.state = {
        status: 'completed',
        input,
        output: result.output,
        title: part.tool,
        metadata: {},
        time: { start: startTime, end: now },
      }
    }
    this.storePart(part)
    this.emitPartUpdated(part)
  }

  private handleResult(message: SDKResultMessage): void {
    const entry = this.currentAssistantMessageId
      ? this.messages.get(this.currentAssistantMessageId)
      : undefined

    if (entry && entry.info.role === 'assistant') {
      const info = entry.info
      info.time.completed = Date.now()
      info.cost = message.total_cost_usd
      info.tokens = {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        reasoning: 0,
        cache: {
          read: message.usage.cache_read_input_tokens ?? 0,
          write: message.usage.cache_creation_input_tokens ?? 0,
        },
      }
      if (message.subtype === 'success') {
        info.finish = 'stop'
      } else {
        info.finish = 'error'
        info.error = this.buildResultError(message)
      }
      // Step-finish part carries cost/tokens for kimaki's footers.
      const stepFinish: StepFinishPart = {
        id: createClaudePartId(),
        sessionID: this.id,
        messageID: info.id,
        type: 'step-finish',
        reason: info.finish,
        cost: info.cost,
        tokens: info.tokens,
      }
      this.storePart(stepFinish)
      this.emitPartUpdated(stepFinish)
      this.emitMessageUpdated(info)
    }

    this.currentAssistantMessageId = null
    this.clearStreamingParts()
    this.setStatus({ type: 'idle' })
    this.manager.persistSession(this)
    void this.emitSessionDiff()
    void this.refreshTitle()
  }

  private buildResultError(message: SDKResultMessage): AssistantMessage['error'] {
    const errors =
      'errors' in message && Array.isArray(message.errors)
        ? message.errors.filter((value): value is string => {
            return typeof value === 'string'
          })
        : []
    const detail = errors.join('; ')
    if (this.abortRequested) {
      return {
        name: 'MessageAbortedError',
        data: { message: 'Request was aborted' },
      }
    }
    if (
      this.lastAssistantError === 'authentication_failed' ||
      this.lastAssistantError === 'oauth_org_not_allowed'
    ) {
      return {
        name: 'ProviderAuthError',
        data: {
          providerID: CLAUDE_CODE_PROVIDER_ID,
          message:
            detail ||
            'Claude Code authentication failed. Run `claude` in a terminal to log in, or set ANTHROPIC_API_KEY.',
        },
      }
    }
    return {
      name: 'UnknownError',
      data: {
        message: detail || `Claude Code run failed (${message.subtype})`,
      },
    }
  }

  private finalizeOpenAssistantMessage({ aborted }: { aborted: boolean }): void {
    const entry = this.currentAssistantMessageId
      ? this.messages.get(this.currentAssistantMessageId)
      : undefined
    this.currentAssistantMessageId = null
    this.clearStreamingParts()
    if (!entry || entry.info.role !== 'assistant') {
      return
    }
    const info = entry.info
    if (typeof info.time.completed === 'number') {
      return
    }
    info.time.completed = Date.now()
    if (aborted) {
      info.error = {
        name: 'MessageAbortedError',
        data: { message: 'Request was aborted' },
      }
    }
    this.emitMessageUpdated(info)
  }

  private clearStreamingParts(): void {
    for (const state of this.streamingParts.values()) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer)
      }
      if (state.dirty) {
        this.storePart(state.part)
        this.emitPartUpdated(state.part)
      }
    }
    this.streamingParts.clear()
  }

  private handleCompactBoundary(auto: boolean): void {
    const entry = this.ensureAssistantMessage()
    const part: Part = {
      id: createClaudePartId(),
      sessionID: this.id,
      messageID: entry.info.id,
      type: 'compaction',
      auto,
    }
    this.storePart(part)
    this.emitPartUpdated(part)
  }

  private async emitSessionDiff(): Promise<void> {
    const diff = await computeGitDiffSummary(this.directory)
    if (!diff) {
      return
    }
    this.session.summary = {
      additions: diff.additions,
      deletions: diff.deletions,
      files: diff.files.length,
      diffs: diff.files,
    }
    this.emit({
      id: createClaudeEventId(),
      type: 'session.diff',
      properties: { sessionID: this.id, diff: diff.files },
    })
    this.emitSessionUpdated()
  }

  /** Adopt the SDK's auto-generated summary as the session title. */
  private async refreshTitle(): Promise<void> {
    if (!this.sdkSessionId) {
      return
    }
    const info = await getSessionInfo(this.sdkSessionId, {
      dir: this.directory,
    }).catch(() => {
      return undefined
    })
    if (!info) {
      return
    }
    const title = info.customTitle || info.summary || info.firstPrompt
    if (title && title !== this.session.title) {
      this.session.title = title.slice(0, 200)
      this.manager.persistSession(this)
      this.emitSessionUpdated()
    }
  }

  // ── Permissions & questions ───────────────────────────────────

  private handleCanUseTool({
    toolName,
    input,
    signal,
    toolUseID,
    blockedPath,
  }: {
    toolName: string
    input: Record<string, unknown>
    signal: AbortSignal
    toolUseID: string
    blockedPath?: string
  }): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') {
      return this.handleAskUserQuestion({ input, signal, toolUseID })
    }
    const descriptor = describeToolPermission({
      toolName,
      input,
      directory: this.directory,
      blockedPath,
    })
    if (!descriptor) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    const rules = this.session.permission ?? []
    const action = evaluatePermission({
      rules,
      permission: descriptor.permission,
      patterns: descriptor.patterns,
    })
    if (action === 'allow') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    if (action === 'deny') {
      return Promise.resolve({
        behavior: 'deny',
        message: `Denied by kimaki permission rules (${descriptor.permission}: ${descriptor.patterns.join(', ')})`,
      })
    }

    const requestId = createClaudePermissionId()
    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingPermission = {
        sessionId: this.id,
        resolve: (result) => {
          this.manager.pendingPermissions.delete(requestId)
          resolve(result)
        },
        input,
        permission: descriptor.permission,
        always: descriptor.always,
      }
      this.manager.pendingPermissions.set(requestId, pending)
      signal.addEventListener('abort', () => {
        if (this.manager.pendingPermissions.has(requestId)) {
          this.manager.pendingPermissions.delete(requestId)
          this.emitPermissionReplied(requestId, 'reject')
          resolve({ behavior: 'deny', message: 'Tool call was aborted' })
        }
      })
      this.emit({
        id: createClaudeEventId(),
        type: 'permission.asked',
        properties: {
          id: requestId,
          sessionID: this.id,
          permission: descriptor.permission,
          patterns: descriptor.patterns,
          metadata: descriptor.metadata,
          always: descriptor.always,
          ...(this.currentAssistantMessageId
            ? {
                tool: {
                  messageID: this.currentAssistantMessageId,
                  callID: toolUseID,
                },
              }
            : {}),
        },
      })
    })
  }

  private handleAskUserQuestion({
    input,
    signal,
    toolUseID,
  }: {
    input: Record<string, unknown>
    signal: AbortSignal
    toolUseID: string
  }): Promise<PermissionResult> {
    const questions = mapAskUserQuestions(input)
    if (questions.length === 0) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    const requestId = createClaudeQuestionId()
    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingQuestion = {
        sessionId: this.id,
        resolve: (result) => {
          this.manager.pendingQuestions.delete(requestId)
          resolve(result)
        },
        questions,
        originalInput: input,
      }
      this.manager.pendingQuestions.set(requestId, pending)
      signal.addEventListener('abort', () => {
        if (this.manager.pendingQuestions.has(requestId)) {
          this.manager.pendingQuestions.delete(requestId)
          resolve({ behavior: 'deny', message: 'Question was aborted' })
        }
      })
      this.emit({
        id: createClaudeEventId(),
        type: 'question.asked',
        properties: {
          id: requestId,
          sessionID: this.id,
          questions,
          ...(this.currentAssistantMessageId
            ? {
                tool: {
                  messageID: this.currentAssistantMessageId,
                  callID: toolUseID,
                },
              }
            : {}),
        },
      })
    })
  }

  emitPermissionReplied(requestId: string, reply: 'once' | 'always' | 'reject'): void {
    this.emit({
      id: createClaudeEventId(),
      type: 'permission.replied',
      properties: { sessionID: this.id, requestID: requestId, reply },
    })
  }

  replyPermission({
    requestId,
    reply,
    message,
  }: {
    requestId: string
    reply: 'once' | 'always' | 'reject'
    message?: string
  }): boolean {
    const pending = this.manager.pendingPermissions.get(requestId)
    if (!pending || pending.sessionId !== this.id) {
      return false
    }
    if (reply === 'always') {
      const newRules = buildAlwaysRules({
        permission: pending.permission,
        always: pending.always,
      })
      this.session.permission = [...(this.session.permission ?? []), ...newRules]
      this.manager.persistSession(this)
    }
    this.emitPermissionReplied(requestId, reply)
    if (reply === 'reject') {
      pending.resolve({
        behavior: 'deny',
        message: message || 'The user denied this tool use',
      })
    } else {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input })
    }
    return true
  }

  replyQuestion({ requestId, answers }: { requestId: string; answers: QuestionAnswer[] }): boolean {
    const pending = this.manager.pendingQuestions.get(requestId)
    if (!pending || pending.sessionId !== this.id) {
      return false
    }
    const updatedInput = buildQuestionAnswersInput({
      originalInput: pending.originalInput,
      questions: pending.questions,
      answers,
    })
    this.emit({
      id: createClaudeEventId(),
      type: 'question.replied',
      properties: { sessionID: this.id, requestID: requestId, answers },
    })
    pending.resolve({ behavior: 'allow', updatedInput })
    return true
  }

  rejectQuestion({ requestId }: { requestId: string }): boolean {
    const pending = this.manager.pendingQuestions.get(requestId)
    if (!pending || pending.sessionId !== this.id) {
      return false
    }
    this.emit({
      id: createClaudeEventId(),
      type: 'question.rejected',
      properties: { sessionID: this.id, requestID: requestId },
    })
    pending.resolve({
      behavior: 'deny',
      message: 'User dismissed the question',
    })
    return true
  }

  // ── Session operations ────────────────────────────────────────

  async abort(): Promise<boolean> {
    this.abortRequested = true
    // Deny pending interactive requests first so canUseTool unblocks.
    for (const [requestId, pending] of this.manager.pendingPermissions) {
      if (pending.sessionId === this.id) {
        this.manager.pendingPermissions.delete(requestId)
        this.emitPermissionReplied(requestId, 'reject')
        pending.resolve({ behavior: 'deny', message: 'Aborted by user', interrupt: true })
      }
    }
    for (const [requestId, pending] of this.manager.pendingQuestions) {
      if (pending.sessionId === this.id) {
        this.manager.pendingQuestions.delete(requestId)
        pending.resolve({ behavior: 'deny', message: 'Aborted by user', interrupt: true })
      }
    }
    const live = this.live
    if (!live) {
      if (this.status.type === 'busy') {
        this.setStatus({ type: 'idle' })
      }
      return true
    }
    await live.query.interrupt().catch((error) => {
      logger.warn(
        `[CLAUDE] interrupt failed for ${this.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    return true
  }

  async summarize(): Promise<void> {
    await this.pushHiddenCommand('/compact')
  }

  async update({
    title,
    permission,
  }: {
    title?: string
    permission?: PermissionRuleset
  }): Promise<Session> {
    if (title !== undefined) {
      this.session.title = title
      if (this.sdkSessionId) {
        const { renameSession } = await import('@anthropic-ai/claude-agent-sdk')
        await renameSession(this.sdkSessionId, title, { dir: this.directory }).catch(() => {
          // Title still applies to the wire session even if the transcript
          // rename fails (e.g. session file not written yet).
        })
      }
    }
    if (permission !== undefined) {
      this.session.permission = permission
    }
    this.manager.persistSession(this)
    this.emitSessionUpdated()
    return this.session
  }

  async revert({ messageID }: { messageID?: string }): Promise<Session> {
    if (!messageID) {
      throw new Error('revert requires a messageID')
    }
    const uuid = this.uuidByMessageId.get(messageID)
    if (!uuid) {
      throw new Error('Cannot revert: message not found in this Claude Code session')
    }
    const live = await this.ensureLive({ model: this.currentModelId })
    await live.query.rewindFiles(uuid)
    this.session.revert = { messageID }
    this.emitSessionUpdated()
    return this.session
  }

  async unrevert(): Promise<Session> {
    const lastMessageId = this.messageOrder[this.messageOrder.length - 1]
    const uuid = lastMessageId ? this.uuidByMessageId.get(lastMessageId) : undefined
    if (uuid && this.live) {
      await this.live.query.rewindFiles(uuid).catch((error) => {
        logger.warn(
          `[CLAUDE] unrevert rewindFiles failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
    delete this.session.revert
    this.emitSessionUpdated()
    return this.session
  }

  fork({ messageID }: { messageID?: string }): ClaudeCodeSession {
    const forked = this.manager.create({
      directory: this.directory,
      permission: [...(this.session.permission ?? [])],
      parentID: this.id,
      title: `Fork of ${this.session.title}`,
    })
    forked.sdkSessionId = this.sdkSessionId
    forked.currentModelId = this.currentModelId
    if (messageID) {
      const uuid = this.uuidByMessageId.get(messageID)
      forked.pendingFork = { resumeSessionAt: uuid }
    } else {
      forked.pendingFork = {}
    }
    // Copy wire history so the forked thread renders past context.
    let reachedCutoff = false
    for (const originalId of this.messageOrder) {
      if (reachedCutoff) {
        break
      }
      const entry = this.messages.get(originalId)
      if (!entry) {
        continue
      }
      const clonedInfo = structuredClone(entry.info)
      clonedInfo.sessionID = forked.id
      forked.storeMessage(clonedInfo)
      for (const part of entry.parts.values()) {
        const clonedPart = structuredClone(part)
        clonedPart.sessionID = forked.id
        forked.storePart(clonedPart)
      }
      const uuid = this.uuidByMessageId.get(originalId)
      if (uuid) {
        forked.uuidByMessageId.set(originalId, uuid)
      }
      if (messageID && originalId === messageID) {
        reachedCutoff = true
      }
    }
    this.manager.persistSession(forked)
    return forked
  }

  async dispose({ deletePersisted }: { deletePersisted: boolean }): Promise<void> {
    this.disposed = true
    if (this.idleReapTimer) {
      clearTimeout(this.idleReapTimer)
      this.idleReapTimer = undefined
    }
    for (const [requestId, pending] of this.manager.pendingPermissions) {
      if (pending.sessionId === this.id) {
        this.manager.pendingPermissions.delete(requestId)
        pending.resolve({ behavior: 'deny', message: 'Session closed' })
      }
    }
    for (const [requestId, pending] of this.manager.pendingQuestions) {
      if (pending.sessionId === this.id) {
        this.manager.pendingQuestions.delete(requestId)
        pending.resolve({ behavior: 'deny', message: 'Session closed' })
      }
    }
    const live = this.live
    this.live = null
    if (live) {
      live.input.end()
      live.abortController.abort()
    }
    if (deletePersisted) {
      const file = persistenceFile(this.id)
      await fs.promises.rm(file, { force: true }).catch(() => {})
    }
  }

  toPersisted(): PersistedSessionState {
    return {
      id: this.id,
      directory: this.directory,
      sdkSessionId: this.sdkSessionId,
      title: this.session.title,
      permission: this.session.permission ?? [],
      parentID: this.session.parentID,
      agent: this.session.agent,
      timeCreated: this.session.time.created,
    }
  }
}

function errToNull<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch {
    return null
  }
}

function isEffortLevel(value: string): value is 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
}

function buildQueryErrorMessage({
  error,
  stderrTail,
}: {
  error: Error
  stderrTail: string[]
}): string {
  const stderrText = stderrTail.join('').trim()
  const authHint = /auth|credential|api key|login/i.test(`${error.message}\n${stderrText}`)
    ? ' If Claude Code is not authenticated on this machine, run `claude` in a terminal to log in or set ANTHROPIC_API_KEY.'
    : ''
  const tail = stderrText ? `\n${stderrText.slice(-400)}` : ''
  return `Claude Code process error: ${error.message}.${authHint}${tail}`
}

async function computeGitDiffSummary(directory: string): Promise<{
  additions: number
  deletions: number
  files: SnapshotFileDiff[]
} | null> {
  const numstat = await execAsync('git diff --numstat HEAD', {
    cwd: directory,
    timeout: 5000,
  }).catch(() => {
    return null
  })
  if (!numstat) {
    return null
  }
  const files: SnapshotFileDiff[] = []
  let additions = 0
  let deletions = 0
  for (const line of numstat.stdout.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim())
    if (!match) {
      continue
    }
    const add = match[1] === '-' ? 0 : Number(match[1])
    const del = match[2] === '-' ? 0 : Number(match[2])
    additions += add
    deletions += del
    files.push({
      file: match[3],
      additions: add,
      deletions: del,
      status: 'modified',
    })
  }
  const untracked = await execAsync('git ls-files --others --exclude-standard', {
    cwd: directory,
    timeout: 5000,
  }).catch(() => {
    return null
  })
  if (untracked) {
    for (const line of untracked.stdout.split('\n')) {
      const file = line.trim()
      if (!file) {
        continue
      }
      files.push({ file, additions: 0, deletions: 0, status: 'added' })
    }
  }
  if (files.length === 0) {
    return null
  }
  return { additions, deletions, files: files.slice(0, 100) }
}

export class ClaudeCodeSessionManager {
  readonly sessions = new Map<string, ClaudeCodeSession>()
  readonly pendingPermissions = new Map<string, PendingPermission>()
  readonly pendingQuestions = new Map<string, PendingQuestion>()
  emitEvent: ClaudeEventSink
  queryImpl: QueryImpl
  modelCatalogLoaded = false
  private slashCommandsByDirectory = new Map<string, string[]>()
  private slashCommandDetails = new Map<string, SlashCommand[]>()
  private agentsByDirectory = new Map<string, string[]>()

  constructor({ emitEvent, queryImpl }: { emitEvent: ClaudeEventSink; queryImpl?: QueryImpl }) {
    this.emitEvent = emitEvent
    this.queryImpl = queryImpl ?? sdkQuery
  }

  create({
    directory,
    permission,
    title,
    parentID,
    agent,
  }: {
    directory: string
    permission?: PermissionRuleset
    title?: string
    parentID?: string
    agent?: string
  }): ClaudeCodeSession {
    const session = new ClaudeCodeSession({
      manager: this,
      id: createClaudeSessionId(),
      directory,
      permission: permission ?? [],
      title,
      parentID,
      agent,
    })
    this.sessions.set(session.id, session)
    this.persistSession(session)
    return session
  }

  /** Look up a session, restoring persisted metadata after a restart. */
  get(sessionId: string): ClaudeCodeSession | undefined {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      return existing
    }
    const file = persistenceFile(sessionId)
    const raw = errToNull(() => {
      return fs.readFileSync(file, 'utf8')
    })
    if (!raw) {
      return undefined
    }
    const parsed = errToNull(() => {
      return JSON.parse(raw) as PersistedSessionState
    })
    if (!parsed || parsed.id !== sessionId) {
      return undefined
    }
    const session = new ClaudeCodeSession({
      manager: this,
      id: parsed.id,
      directory: parsed.directory,
      permission: parsed.permission,
      title: parsed.title,
      parentID: parsed.parentID,
      sdkSessionId: parsed.sdkSessionId,
      timeCreated: parsed.timeCreated,
      agent: parsed.agent,
    })
    this.sessions.set(session.id, session)
    return session
  }

  list({ directory }: { directory?: string }): Session[] {
    this.loadAllPersisted()
    return [...this.sessions.values()]
      .filter((session) => {
        return !directory || session.directory === directory
      })
      .map((session) => {
        return session.toWire()
      })
      .sort((a, b) => {
        return b.time.updated - a.time.updated
      })
  }

  private allPersistedLoaded = false

  private loadAllPersisted(): void {
    if (this.allPersistedLoaded) {
      return
    }
    this.allPersistedLoaded = true
    const dir = persistenceDir()
    const entries = errToNull(() => {
      return fs.readdirSync(dir)
    })
    if (!entries) {
      return
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue
      }
      this.get(entry.slice(0, -'.json'.length))
    }
  }

  statuses({ directory }: { directory?: string }): Record<string, SessionStatus> {
    const result: Record<string, SessionStatus> = {}
    for (const session of this.sessions.values()) {
      if (directory && session.directory !== directory) {
        continue
      }
      result[session.id] = session.getStatus()
    }
    return result
  }

  async delete(sessionId: string): Promise<boolean> {
    const session = this.get(sessionId)
    if (!session) {
      return false
    }
    await session.dispose({ deletePersisted: true })
    this.sessions.delete(sessionId)
    return true
  }

  persistSession(session: ClaudeCodeSession): void {
    const dir = persistenceDir()
    const writeResult = errToNull(() => {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(persistenceFile(session.id), JSON.stringify(session.toPersisted(), null, 2))
      return true
    })
    if (!writeResult) {
      logger.warn(`[CLAUDE] Failed to persist session state for ${session.id}`)
    }
  }

  recordRuntimeInfo({
    directory,
    slashCommands,
    agents,
  }: {
    directory: string
    slashCommands: string[]
    agents: string[]
  }): void {
    this.slashCommandsByDirectory.set(directory, slashCommands)
    this.agentsByDirectory.set(directory, agents)
  }

  recordSlashCommandDetails(directory: string, commands: SlashCommand[]): void {
    this.slashCommandDetails.set(directory, commands)
  }

  getSlashCommands(directory: string): SlashCommand[] {
    const detailed = this.slashCommandDetails.get(directory)
    if (detailed) {
      return detailed
    }
    const names = this.slashCommandsByDirectory.get(directory) ?? []
    return names.map((name) => {
      return { name, description: '', argumentHint: '' }
    })
  }

  getAgents(directory: string): string[] {
    return this.agentsByDirectory.get(directory) ?? []
  }

  replyPermission({
    requestId,
    reply,
    message,
  }: {
    requestId: string
    reply: 'once' | 'always' | 'reject'
    message?: string
  }): boolean {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) {
      return false
    }
    const session = this.sessions.get(pending.sessionId)
    if (!session) {
      return false
    }
    return session.replyPermission({ requestId, reply, message })
  }

  replyQuestion({ requestId, answers }: { requestId: string; answers: QuestionAnswer[] }): boolean {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) {
      return false
    }
    const session = this.sessions.get(pending.sessionId)
    if (!session) {
      return false
    }
    return session.replyQuestion({ requestId, answers })
  }

  rejectQuestion({ requestId }: { requestId: string }): boolean {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) {
      return false
    }
    const session = this.sessions.get(pending.sessionId)
    if (!session) {
      return false
    }
    return session.rejectQuestion({ requestId })
  }

  async disposeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) => {
        return session.dispose({ deletePersisted: false })
      }),
    )
    this.sessions.clear()
  }
}
