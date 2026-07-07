// Translation between Claude Agent SDK messages and OpenCode wire types.
//
// The Claude backend speaks OpenCode's protocol to the rest of kimaki, so
// everything the SDK emits (assistant content blocks, tool results, results)
// must be reshaped into OpenCode Message/Part objects. Pure functions only —
// session state lives in sessions.ts.

import type {
  AssistantMessage,
  Message,
  Part,
  QuestionInfo,
  TextPart,
  ToolPart,
  ReasoningPart,
  FilePartInput,
  TextPartInput,
} from '@opencode-ai/sdk/v2'
import type { SDKAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_CODE_PROVIDER_ID } from './models.js'
import { createClaudeMessageId, createClaudePartId } from './ids.js'

// Content block unions derived from the SDK's own message types so we don't
// have to depend on @anthropic-ai/sdk directly.
export type AssistantContentBlock = SDKAssistantMessage['message']['content'][number]
export type UserMessageParam = SDKUserMessage['message']
type UserContentBlock = Exclude<UserMessageParam['content'], string>[number]

export type WireMessageWithParts = {
  info: Message
  parts: Part[]
}

export function buildAssistantInfo({
  sessionId,
  messageId,
  parentUserMessageId,
  modelId,
  directory,
  agent,
  created,
}: {
  sessionId: string
  messageId: string
  parentUserMessageId: string
  modelId: string
  directory: string
  agent: string
  created: number
}): AssistantMessage {
  return {
    id: messageId,
    sessionID: sessionId,
    role: 'assistant',
    time: { created },
    parentID: parentUserMessageId,
    modelID: modelId,
    providerID: CLAUDE_CODE_PROVIDER_ID,
    mode: agent,
    agent,
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }
}

export function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object') {
          const rec = block as Record<string, unknown>
          if (rec.type === 'text' && typeof rec.text === 'string') {
            return rec.text
          }
          if (rec.type === 'image') {
            return '[image]'
          }
        }
        return ''
      })
      .filter((text) => {
        return text.length > 0
      })
      .join('\n')
  }
  if (content == null) {
    return ''
  }
  return JSON.stringify(content)
}

export type ToolResultBlock = {
  toolUseId: string
  output: string
  isError: boolean
}

/** Extract tool_result blocks from an SDK user message (tool result carrier). */
export function extractToolResults(message: UserMessageParam): ToolResultBlock[] {
  if (typeof message.content === 'string') {
    return []
  }
  const results: ToolResultBlock[] = []
  for (const block of message.content) {
    if (block.type !== 'tool_result') {
      continue
    }
    results.push({
      toolUseId: block.tool_use_id,
      output: stringifyToolResultContent(block.content),
      isError: block.is_error === true,
    })
  }
  return results
}

/**
 * Convert OpenCode prompt parts (text + data-url file parts) into an SDK
 * MessageParam content array. Discord images arrive as data URLs; PDFs become
 * document blocks.
 */
export function buildUserContent({
  parts,
}: {
  parts: Array<TextPartInput | FilePartInput>
}): Exclude<UserMessageParam['content'], string> {
  const content: UserContentBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.trim().length === 0) {
        continue
      }
      content.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'file') {
      const parsed = parseDataUrl(part.url)
      if (!parsed) {
        content.push({
          type: 'text',
          text: `[attachment: ${part.filename ?? part.url}]`,
        })
        continue
      }
      if (parsed.mime === 'application/pdf') {
        content.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: parsed.data,
          },
        })
        continue
      }
      if (isSupportedImageMime(parsed.mime)) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: parsed.mime,
            data: parsed.data,
          },
        })
        continue
      }
      content.push({
        type: 'text',
        text: `[unsupported attachment type ${parsed.mime}: ${part.filename ?? ''}]`,
      })
    }
  }
  return content
}

type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

function isSupportedImageMime(mime: string): mime is SupportedImageMime {
  return (
    mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp'
  )
}

function parseDataUrl(url: string): { mime: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  if (!match) {
    return null
  }
  return { mime: match[1]!, data: match[2]! }
}

/**
 * Map AskUserQuestion tool input questions into OpenCode QuestionInfo entries
 * (they are nearly identical by design).
 */
export function mapAskUserQuestions(input: Record<string, unknown>): QuestionInfo[] {
  const rawQuestions = input.questions
  if (!Array.isArray(rawQuestions)) {
    return []
  }
  const questions: QuestionInfo[] = []
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const rec = raw as Record<string, unknown>
    const question = typeof rec.question === 'string' ? rec.question : ''
    const header = typeof rec.header === 'string' ? rec.header : ''
    const optionsRaw = Array.isArray(rec.options) ? rec.options : []
    const options = optionsRaw.flatMap((opt) => {
      if (!opt || typeof opt !== 'object') {
        return []
      }
      const optRec = opt as Record<string, unknown>
      const label = typeof optRec.label === 'string' ? optRec.label : ''
      if (!label) {
        return []
      }
      return [
        {
          label,
          description: typeof optRec.description === 'string' ? optRec.description : '',
        },
      ]
    })
    if (!question || options.length === 0) {
      continue
    }
    questions.push({
      question,
      header: header || question.slice(0, 30),
      options,
      multiple: rec.multiSelect === true,
      custom: true,
    })
  }
  return questions
}

/**
 * Build the AskUserQuestion updatedInput payload from kimaki question answers.
 * Answer values are option labels; multi-select questions get arrays.
 */
export function buildQuestionAnswersInput({
  originalInput,
  questions,
  answers,
}: {
  originalInput: Record<string, unknown>
  questions: QuestionInfo[]
  answers: string[][]
}): Record<string, unknown> {
  const answerMap: Record<string, string | string[]> = {}
  questions.forEach((question, index) => {
    const selected = answers[index] ?? []
    if (selected.length === 0) {
      return
    }
    answerMap[question.question] = question.multiple ? selected : (selected[0] ?? '')
  })
  return {
    questions: originalInput.questions,
    answers: answerMap,
  }
}

export type TranslatedBlockPart = Part

/**
 * Translate a complete assistant content block into an OpenCode part.
 * Used both for live reconciliation and for transcript hydration.
 */
export function translateAssistantBlock({
  block,
  sessionId,
  messageId,
  now,
}: {
  block: AssistantContentBlock
  sessionId: string
  messageId: string
  now: number
}): Part | null {
  if (block.type === 'text') {
    const part: TextPart = {
      id: createClaudePartId(),
      sessionID: sessionId,
      messageID: messageId,
      type: 'text',
      text: block.text,
      time: { start: now, end: now },
    }
    return part
  }
  if (block.type === 'thinking') {
    const part: ReasoningPart = {
      id: createClaudePartId(),
      sessionID: sessionId,
      messageID: messageId,
      type: 'reasoning',
      text: block.thinking,
      time: { start: now, end: now },
    }
    return part
  }
  if (block.type === 'redacted_thinking') {
    const part: ReasoningPart = {
      id: createClaudePartId(),
      sessionID: sessionId,
      messageID: messageId,
      type: 'reasoning',
      text: '[redacted thinking]',
      time: { start: now, end: now },
    }
    return part
  }
  if (block.type === 'tool_use') {
    const part: ToolPart = {
      id: createClaudePartId(),
      sessionID: sessionId,
      messageID: messageId,
      type: 'tool',
      callID: block.id,
      tool: normalizeToolName(block.name),
      state: {
        status: 'running',
        input: asRecord(block.input),
        title: normalizeToolName(block.name),
        time: { start: now },
      },
    }
    return part
  }
  return null
}

/**
 * OpenCode tool names are lowercase (bash, edit, read...). Claude tool names
 * are TitleCase (Bash, Edit, Read...). Kimaki's formatting layer special-cases
 * the lowercase names, so normalize the common ones and lowercase the rest.
 */
export function normalizeToolName(toolName: string): string {
  const mapping: Record<string, string> = {
    Bash: 'bash',
    Edit: 'edit',
    MultiEdit: 'edit',
    Write: 'write',
    Read: 'read',
    Glob: 'glob',
    Grep: 'grep',
    Task: 'task',
    TodoWrite: 'todowrite',
    TodoRead: 'todoread',
    WebFetch: 'webfetch',
    WebSearch: 'websearch',
    NotebookEdit: 'edit',
    ExitPlanMode: 'plan_exit',
    AskUserQuestion: 'question',
    KillShell: 'bash',
    BashOutput: 'bash',
    SlashCommand: 'command',
    Skill: 'skill',
  }
  if (mapping[toolName]) {
    return mapping[toolName]
  }
  const mcpMatch = /^mcp__[^_]+__(.+)$/.exec(toolName)
  if (mcpMatch) {
    return mcpMatch[1]!
  }
  return toolName.toLowerCase()
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

/**
 * Hydrate OpenCode wire messages from a persisted Claude Code transcript
 * (SDK getSessionMessages output). Used after bot restarts so /resume and
 * session.messages keep working for claude-backed threads.
 */
export function translateTranscriptMessages({
  transcript,
  sessionId,
  directory,
  agent,
}: {
  transcript: Array<{
    type: 'user' | 'assistant' | 'system'
    uuid: string
    message: unknown
    parent_tool_use_id: string | null
  }>
  sessionId: string
  directory: string
  agent: string
}): { messages: WireMessageWithParts[]; uuidByMessageId: Map<string, string> } {
  const messages: WireMessageWithParts[] = []
  const uuidByMessageId = new Map<string, string>()
  const toolPartsByCallId = new Map<string, ToolPart>()
  let lastUserMessageId = ''
  let modelId = ''
  const now = Date.now()

  for (const entry of transcript) {
    if (entry.parent_tool_use_id) {
      continue
    }
    const messageRecord = asRecord(entry.message)
    if (entry.type === 'user') {
      const content = messageRecord.content
      // Tool-result carrier messages update existing tool parts instead of
      // becoming visible user messages.
      if (Array.isArray(content)) {
        let onlyToolResults = content.length > 0
        for (const block of content) {
          const rec = asRecord(block)
          if (rec.type !== 'tool_result') {
            onlyToolResults = false
          }
        }
        if (onlyToolResults) {
          for (const block of content) {
            const rec = asRecord(block)
            const callId = typeof rec.tool_use_id === 'string' ? rec.tool_use_id : ''
            const part = toolPartsByCallId.get(callId)
            if (!part) {
              continue
            }
            const output = stringifyToolResultContent(rec.content)
            if (rec.is_error === true) {
              part.state = {
                status: 'error',
                input: part.state.input,
                error: output,
                time: { start: now, end: now },
              }
            } else {
              part.state = {
                status: 'completed',
                input: part.state.input,
                output,
                title: part.tool,
                metadata: {},
                time: { start: now, end: now },
              }
            }
          }
          continue
        }
      }
      const text = (() => {
        if (typeof content === 'string') {
          return content
        }
        if (!Array.isArray(content)) {
          return ''
        }
        return content
          .map((block) => {
            const rec = asRecord(block)
            return rec.type === 'text' && typeof rec.text === 'string' ? rec.text : ''
          })
          .filter((value) => {
            return value.length > 0
          })
          .join('\n')
      })()
      if (!text) {
        continue
      }
      const messageId = createClaudeMessageId()
      lastUserMessageId = messageId
      uuidByMessageId.set(messageId, entry.uuid)
      const textPart: TextPart = {
        id: createClaudePartId(),
        sessionID: sessionId,
        messageID: messageId,
        type: 'text',
        text,
        time: { start: now, end: now },
      }
      messages.push({
        info: {
          id: messageId,
          sessionID: sessionId,
          role: 'user',
          time: { created: now },
          agent,
          model: {
            providerID: CLAUDE_CODE_PROVIDER_ID,
            modelID: modelId || 'claude-code',
          },
        },
        parts: [textPart],
      })
      continue
    }
    if (entry.type === 'assistant') {
      const model = typeof messageRecord.model === 'string' ? messageRecord.model : ''
      if (model) {
        modelId = model
      }
      const messageId = createClaudeMessageId()
      uuidByMessageId.set(messageId, entry.uuid)
      const info = buildAssistantInfo({
        sessionId,
        messageId,
        parentUserMessageId: lastUserMessageId,
        modelId: modelId || 'claude-code',
        directory,
        agent,
        created: now,
      })
      info.time.completed = now
      info.finish = 'stop'
      const parts: Part[] = []
      const content = messageRecord.content
      if (Array.isArray(content)) {
        for (const block of content) {
          const part = translateAssistantBlock({
            block: block as AssistantContentBlock,
            sessionId,
            messageId,
            now,
          })
          if (!part) {
            continue
          }
          parts.push(part)
          if (part.type === 'tool') {
            toolPartsByCallId.set(part.callID, part)
          }
        }
      }
      messages.push({ info, parts })
    }
  }

  return { messages, uuidByMessageId }
}
