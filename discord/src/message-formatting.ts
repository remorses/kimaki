import type { Part, FilePartInput } from '@opencode-ai/sdk'
import type { Message } from 'discord.js'
import { createLogger } from './logger.js'

const logger = createLogger('FORMATTING')

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
  const textAttachments = Array.from(message.attachments.values()).filter(
    (attachment) => isTextMimeType(attachment.contentType),
  )

  if (textAttachments.length === 0) {
    return ''
  }

  const textContents = await Promise.all(
    textAttachments.map(async (attachment) => {
      try {
        const response = await fetch(attachment.url)
        if (!response.ok) {
          return `<attachment filename="${attachment.name}" error="Failed to fetch: ${response.status}" />`
        }
        const text = await response.text()
        return `<attachment filename="${attachment.name}" mime="${attachment.contentType}">\n${text}\n</attachment>`
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        return `<attachment filename="${attachment.name}" error="${errMsg}" />`
      }
    }),
  )

  return textContents.join('\n\n')
}

export function getFileAttachments(message: Message): FilePartInput[] {
  const fileAttachments = Array.from(message.attachments.values()).filter(
    (attachment) => {
      const contentType = attachment.contentType || ''
      return (
        contentType.startsWith('image/') || contentType === 'application/pdf'
      )
    },
  )

  return fileAttachments.map((attachment) => ({
    type: 'file' as const,
    mime: attachment.contentType || 'application/octet-stream',
    filename: attachment.name,
    url: attachment.url,
  }))
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
    return fileName ? `*${fileName}* (+${added}-${removed})` : `(+${added}-${removed})`
  }

  if (part.tool === 'write') {
    const filePath = (part.state.input?.filePath as string) || ''
    const content = (part.state.input?.content as string) || ''
    const lines = content.split('\n').length
    const fileName = filePath.split('/').pop() || ''
    return fileName ? `*${fileName}* (${lines} line${lines === 1 ? '' : 's'})` : `(${lines} line${lines === 1 ? '' : 's'})`
  }

  if (part.tool === 'webfetch') {
    const url = (part.state.input?.url as string) || ''
    const urlWithoutProtocol = url.replace(/^https?:\/\//, '')
    return urlWithoutProtocol ? `*${urlWithoutProtocol}*` : ''
  }

  if (part.tool === 'read') {
    const filePath = (part.state.input?.filePath as string) || ''
    const fileName = filePath.split('/').pop() || ''
    return fileName ? `*${fileName}*` : ''
  }

  if (part.tool === 'list') {
    const path = (part.state.input?.path as string) || ''
    const dirName = path.split('/').pop() || path
    return dirName ? `*${dirName}*` : ''
  }

  if (part.tool === 'glob') {
    const pattern = (part.state.input?.pattern as string) || ''
    return pattern ? `*${pattern}*` : ''
  }

  if (part.tool === 'grep') {
    const pattern = (part.state.input?.pattern as string) || ''
    return pattern ? `*${pattern}*` : ''
  }

  if (part.tool === 'bash' || part.tool === 'todoread' || part.tool === 'todowrite') {
    return ''
  }

  if (part.tool === 'task') {
    const description = (part.state.input?.description as string) || ''
    return description ? `_${description}_` : ''
  }

  if (part.tool === 'skill') {
    const name = (part.state.input?.name as string) || ''
    return name ? `_${name}_` : ''
  }

  if (!part.state.input) return ''

  const inputFields = Object.entries(part.state.input)
    .map(([key, value]) => {
      if (value === null || value === undefined) return null
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
      const truncatedValue = stringValue.length > 300 ? stringValue.slice(0, 300) + '…' : stringValue
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
  return `${activeIndex + 1}. **${activeTodo.content}**`
}

export function formatPart(part: Part): string {
  if (part.type === 'text') {
    return part.text || ''
  }

  if (part.type === 'reasoning') {
    if (!part.text?.trim()) return ''
    return `◼︎ thinking`
  }

  if (part.type === 'file') {
    return `📄 ${part.filename || 'File'}`
  }

  if (part.type === 'step-start' || part.type === 'step-finish' || part.type === 'patch') {
    return ''
  }

  if (part.type === 'agent') {
    return `◼︎ agent ${part.id}`
  }

  if (part.type === 'snapshot') {
    return `◼︎ snapshot ${part.snapshot}`
  }

  if (part.type === 'tool') {
    if (part.tool === 'todowrite') {
      return formatTodoList(part)
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
      const hasUnderscores = command.includes('_')
      if (isSingleLine && !hasUnderscores && command.length <= 50) {
        toolTitle = `_${command}_`
      } else if (description) {
        toolTitle = `_${description}_`
      } else if (stateTitle) {
        toolTitle = `_${stateTitle}_`
      }
    } else if (stateTitle) {
      toolTitle = `_${stateTitle}_`
    }

    const icon = part.state.status === 'error' ? '⨯' : '◼︎'
    return `${icon} ${part.tool} ${toolTitle} ${summaryText}`
  }

  logger.warn('Unknown part type:', part)
  return ''
}
