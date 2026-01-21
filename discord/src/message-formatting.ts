// OpenCode message part formatting for Discord.
// Converts SDK message parts (text, tools, reasoning) to Discord-friendly format,
// handles file attachments, and provides tool summary generation.

import type { Part } from '@opencode-ai/sdk/v2'
import type { FilePartInput } from '@opencode-ai/sdk'
import type { Message } from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import * as errore from 'errore'
import { createLogger } from './logger.js'
import { FetchError } from './errors.js'

// Generic message type compatible with both v1 and v2 SDK
type GenericSessionMessage = {
  info: { role: string; id?: string }
  parts: Part[]
}

const ATTACHMENTS_DIR = path.join(process.cwd(), 'tmp', 'discord-attachments')

const logger = createLogger('FORMATTING')

/**
 * Escapes Discord inline markdown characters so dynamic content
 * doesn't break formatting when wrapped in *, _, **, etc.
 */
function escapeInlineMarkdown(text: string): string {
  return text.replace(/([*_~|`\\])/g, '\\$1')
}

/**
 * Collects and formats the last N assistant parts from session messages.
 * Used by both /resume and /fork to show recent assistant context.
 */
export function collectLastAssistantParts({
  messages,
  limit = 30,
}: {
  messages: GenericSessionMessage[]
  limit?: number
}): { partIds: string[]; content: string; skippedCount: number } {
  const allAssistantParts: { id: string; content: string }[] = []

  for (const message of messages) {
    if (message.info.role === 'assistant') {
      for (const part of message.parts) {
        const content = formatPart(part)
        if (content.trim()) {
          allAssistantParts.push({ id: part.id, content: content.trimEnd() })
        }
      }
    }
  }

  const partsToRender = allAssistantParts.slice(-limit)
  const partIds = partsToRender.map((p) => p.id)
  const content = partsToRender.map((p) => p.content).join('\n')
  const skippedCount = allAssistantParts.length - partsToRender.length

  return { partIds, content, skippedCount }
}

export const TEXT_MIME_TYPES = [
  'text/',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/toml',
]

export function isTextMimeType(contentType: string | null): boolean {
  if (!contentType) {
    return false
  }
  return TEXT_MIME_TYPES.some((prefix) => contentType.startsWith(prefix))
}

export async function getTextAttachments(message: Message): Promise<string> {
  const textAttachments = Array.from(message.attachments.values()).filter((attachment) =>
    isTextMimeType(attachment.contentType),
  )

  if (textAttachments.length === 0) {
    return ''
  }

  const textContents = await Promise.all(
    textAttachments.map(async (attachment) => {
      const response = await errore.tryAsync({
        try: () => fetch(attachment.url),
        catch: (e) => new FetchError({ url: attachment.url, cause: e }),
      })
      if (errore.isError(response)) {
        return `<attachment filename="${attachment.name}" error="${response.message}" />`
      }
      if (!response.ok) {
        return `<attachment filename="${attachment.name}" error="Failed to fetch: ${response.status}" />`
      }
      const text = await response.text()
      return `<attachment filename="${attachment.name}" mime="${attachment.contentType}">\n${text}\n</attachment>`
    }),
  )

  return textContents.join('\n\n')
}

export async function getFileAttachments(message: Message): Promise<FilePartInput[]> {
  const fileAttachments = Array.from(message.attachments.values()).filter((attachment) => {
    const contentType = attachment.contentType || ''
    return contentType.startsWith('image/') || contentType === 'application/pdf'
  })

  if (fileAttachments.length === 0) {
    return []
  }

  // ensure tmp directory exists
  if (!fs.existsSync(ATTACHMENTS_DIR)) {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true })
  }

  const results = await Promise.all(
    fileAttachments.map(async (attachment) => {
      const response = await errore.tryAsync({
        try: () => fetch(attachment.url),
        catch: (e) => new FetchError({ url: attachment.url, cause: e }),
      })
      if (errore.isError(response)) {
        logger.error(`Error downloading attachment ${attachment.name}:`, response.message)
        return null
      }
      if (!response.ok) {
        logger.error(`Failed to fetch attachment ${attachment.name}: ${response.status}`)
        return null
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      const localPath = path.join(ATTACHMENTS_DIR, `${message.id}-${attachment.name}`)
      fs.writeFileSync(localPath, buffer)

      logger.log(`Downloaded attachment to ${localPath}`)

      return {
        type: 'file' as const,
        mime: attachment.contentType || 'application/octet-stream',
        filename: attachment.name,
        url: localPath,
      }
    }),
  )

  return results.filter((r) => r !== null) as FilePartInput[]
}

export function getToolSummaryText(part: Part): string {
  if (part.type !== 'tool') return ''

  if (part.tool === 'edit') {
    const filePath = (part.state.input?.filePath as string) || ''
    const newString = (part.state.input?.newString as string) || ''
    const oldString = (part.state.input?.oldString as string) || ''
    const added = newString.split('\n').length
    const removed = oldString.split('\n').length
    const fileName = filePath.split('/').pop() || ''
    return fileName
      ? `*${escapeInlineMarkdown(fileName)}* (+${added}-${removed})`
      : `(+${added}-${removed})`
  }

  if (part.tool === 'write') {
    const filePath = (part.state.input?.filePath as string) || ''
    const content = (part.state.input?.content as string) || ''
    const lines = content.split('\n').length
    const fileName = filePath.split('/').pop() || ''
    return fileName
      ? `*${escapeInlineMarkdown(fileName)}* (${lines} line${lines === 1 ? '' : 's'})`
      : `(${lines} line${lines === 1 ? '' : 's'})`
  }

  if (part.tool === 'webfetch') {
    const url = (part.state.input?.url as string) || ''
    const urlWithoutProtocol = url.replace(/^https?:\/\//, '')
    return urlWithoutProtocol ? `*${escapeInlineMarkdown(urlWithoutProtocol)}*` : ''
  }

  if (part.tool === 'read') {
    const filePath = (part.state.input?.filePath as string) || ''
    const fileName = filePath.split('/').pop() || ''
    return fileName ? `*${escapeInlineMarkdown(fileName)}*` : ''
  }

  if (part.tool === 'list') {
    const path = (part.state.input?.path as string) || ''
    const dirName = path.split('/').pop() || path
    return dirName ? `*${escapeInlineMarkdown(dirName)}*` : ''
  }

  if (part.tool === 'glob') {
    const pattern = (part.state.input?.pattern as string) || ''
    return pattern ? `*${escapeInlineMarkdown(pattern)}*` : ''
  }

  if (part.tool === 'grep') {
    const pattern = (part.state.input?.pattern as string) || ''
    return pattern ? `*${escapeInlineMarkdown(pattern)}*` : ''
  }

  if (part.tool === 'bash' || part.tool === 'todoread' || part.tool === 'todowrite') {
    return ''
  }

  // Task tool display is handled via subtask part in session-handler (shows label like explore-1)
  if (part.tool === 'task') {
    return ''
  }

  if (part.tool === 'skill') {
    const name = (part.state.input?.name as string) || ''
    return name ? `_${escapeInlineMarkdown(name)}_` : ''
  }

  if (!part.state.input) return ''

  const inputFields = Object.entries(part.state.input)
    .map(([key, value]) => {
      if (value === null || value === undefined) return null
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
      const truncatedValue = stringValue.length > 50 ? stringValue.slice(0, 50) + '…' : stringValue
      return `${key}: ${truncatedValue}`
    })
    .filter(Boolean)

  if (inputFields.length === 0) return ''

  return `(${inputFields.join(', ')})`
}

export function formatTodoList(part: Part): string {
  if (part.type !== 'tool' || part.tool !== 'todowrite') return ''
  const todos =
    (part.state.input?.todos as {
      content: string
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
    }[]) || []
  const activeIndex = todos.findIndex((todo) => {
    return todo.status === 'in_progress'
  })
  const activeTodo = todos[activeIndex]
  if (activeIndex === -1 || !activeTodo) return ''
  // digit-with-period ⒈-⒛ for 1-20, fallback to regular number for 21+
  const digitWithPeriod = '⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑⒒⒓⒔⒕⒖⒗⒘⒙⒚⒛'
  const todoNumber = activeIndex + 1
  const num = todoNumber <= 20 ? digitWithPeriod[todoNumber - 1] : `${todoNumber}.`
  const content = activeTodo.content.charAt(0).toLowerCase() + activeTodo.content.slice(1)
  return `${num} **${escapeInlineMarkdown(content)}**`
}

export function formatPart(part: Part, prefix?: string): string {
  const pfx = prefix ? `${prefix}: ` : ''

  if (part.type === 'text') {
    if (!part.text?.trim()) return ''
    // For subtask text, always use bullet with prefix
    if (prefix) {
      return `⬥ ${pfx}${part.text.trim()}`
    }
    const trimmed = part.text.trimStart()
    const firstChar = trimmed[0] || ''
    const markdownStarters = ['#', '*', '_', '-', '>', '`', '[', '|']
    const startsWithMarkdown = markdownStarters.includes(firstChar) || /^\d+\./.test(trimmed)
    if (startsWithMarkdown) {
      return `\n${part.text}`
    }
    return `⬥ ${part.text}`
  }

  if (part.type === 'reasoning') {
    if (!part.text?.trim()) return ''
    return `┣ ${pfx}thinking`
  }

  if (part.type === 'file') {
    return prefix ? `📄 ${pfx}${part.filename || 'File'}` : `📄 ${part.filename || 'File'}`
  }

  if (part.type === 'step-start' || part.type === 'step-finish' || part.type === 'patch') {
    return ''
  }

  if (part.type === 'agent') {
    return `┣ ${pfx}agent ${part.id}`
  }

  if (part.type === 'snapshot') {
    return `┣ ${pfx}snapshot ${part.snapshot}`
  }

  if (part.type === 'tool') {
    if (part.tool === 'todowrite') {
      const formatted = formatTodoList(part)
      return prefix && formatted ? `┣ ${pfx}${formatted}` : formatted
    }

    // Question tool is handled via Discord dropdowns, not text
    if (part.tool === 'question') {
      return ''
    }

    // Task tool display is handled in session-handler with proper label
    if (part.tool === 'task') {
      return ''
    }

    if (part.state.status === 'pending') {
      return ''
    }

    const summaryText = getToolSummaryText(part)
    const stateTitle = 'title' in part.state ? part.state.title : undefined

    let toolTitle = ''
    if (part.state.status === 'error') {
      toolTitle = part.state.error || 'error'
    } else if (part.tool === 'bash') {
      const command = (part.state.input?.command as string) || ''
      const description = (part.state.input?.description as string) || ''
      const isSingleLine = !command.includes('\n')
      if (isSingleLine && command.length <= 50) {
        toolTitle = `_${escapeInlineMarkdown(command)}_`
      } else if (description) {
        toolTitle = `_${escapeInlineMarkdown(description)}_`
      } else if (stateTitle) {
        toolTitle = `_${escapeInlineMarkdown(stateTitle)}_`
      }
    } else if (stateTitle) {
      toolTitle = `_${escapeInlineMarkdown(stateTitle)}_`
    }

    const icon = (() => {
      if (part.state.status === 'error') {
        return '⨯'
      }
      if (part.tool === 'edit' || part.tool === 'write') {
        return '◼︎'
      }
      return '┣'
    })()
    return `${icon} ${pfx}${part.tool} ${toolTitle} ${summaryText}`.trim()
  }

  logger.warn('Unknown part type:', part)
  return ''
}
