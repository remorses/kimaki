// Discord-specific utility functions.
// Handles markdown splitting for Discord's 2000-char limit, code block escaping,
// thread message sending, and channel metadata extraction from topic tags.

import { ChannelType, type Message, type TextChannel, type ThreadChannel } from 'discord.js'
import { Lexer } from 'marked'
import { formatMarkdownTables } from './format-tables.js'
import { getChannelDirectory } from './database.js'
import { limitHeadingDepth } from './limit-heading-depth.js'
import { unnestCodeBlocksFromLists } from './unnest-code-blocks.js'
import { createLogger, LogPrefix } from './logger.js'
import mime from 'mime'
import fs from 'node:fs'
import path from 'node:path'

const discordLogger = createLogger(LogPrefix.DISCORD)

export const SILENT_MESSAGE_FLAGS = 4 | 4096
// Same as SILENT but without SuppressNotifications - triggers badge/notification
export const NOTIFY_MESSAGE_FLAGS = 4

export function escapeBackticksInCodeBlocks(markdown: string): string {
  const lexer = new Lexer()
  const tokens = lexer.lex(markdown)

  let result = ''

  for (const token of tokens) {
    if (token.type === 'code') {
      const escapedCode = token.text.replace(/`/g, '\\`')
      result += '```' + (token.lang || '') + '\n' + escapedCode + '\n```\n'
    } else {
      result += token.raw
    }
  }

  return result
}

type LineInfo = {
  text: string
  inCodeBlock: boolean
  lang: string
  isOpeningFence: boolean
  isClosingFence: boolean
}

export function splitMarkdownForDiscord({
  content,
  maxLength,
}: {
  content: string
  maxLength: number
}): string[] {
  if (content.length <= maxLength) {
    return [content]
  }

  const lexer = new Lexer()
  const tokens = lexer.lex(content)

  const lines: LineInfo[] = []
  const ensureNewlineBeforeCode = (): void => {
    const last = lines[lines.length - 1]
    if (!last) {
      return
    }
    if (last.text.endsWith('\n')) {
      return
    }
    lines.push({
      text: '\n',
      inCodeBlock: false,
      lang: '',
      isOpeningFence: false,
      isClosingFence: false,
    })
  }
  for (const token of tokens) {
    if (token.type === 'code') {
      ensureNewlineBeforeCode()
      const lang = token.lang || ''
      lines.push({
        text: '```' + lang + '\n',
        inCodeBlock: false,
        lang,
        isOpeningFence: true,
        isClosingFence: false,
      })
      const codeLines = token.text.split('\n')
      for (const codeLine of codeLines) {
        lines.push({
          text: codeLine + '\n',
          inCodeBlock: true,
          lang,
          isOpeningFence: false,
          isClosingFence: false,
        })
      }
      lines.push({
        text: '```\n',
        inCodeBlock: false,
        lang: '',
        isOpeningFence: false,
        isClosingFence: true,
      })
    } else {
      const rawLines = token.raw.split('\n')
      for (let i = 0; i < rawLines.length; i++) {
        const isLast = i === rawLines.length - 1
        const text = isLast ? rawLines[i]! : rawLines[i]! + '\n'
        if (text) {
          lines.push({
            text,
            inCodeBlock: false,
            lang: '',
            isOpeningFence: false,
            isClosingFence: false,
          })
        }
      }
    }
  }

  const chunks: string[] = []
  let currentChunk = ''
  let currentLang: string | null = null

  // helper to split a long line into smaller pieces at word boundaries or hard breaks
  const splitLongLine = (text: string, available: number, inCode: boolean): string[] => {
    const pieces: string[] = []
    let remaining = text

    while (remaining.length > available) {
      let splitAt = available
      // for non-code, try to split at word boundary
      if (!inCode) {
        const lastSpace = remaining.lastIndexOf(' ', available)
        if (lastSpace > available * 0.5) {
          splitAt = lastSpace + 1
        }
      }
      pieces.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt)
    }
    if (remaining) {
      pieces.push(remaining)
    }
    return pieces
  }

  const closingFence = '```\n'

  for (const line of lines) {
    const openingFenceSize =
      currentChunk.length === 0 && (line.inCodeBlock || line.isOpeningFence)
        ? ('```' + line.lang + '\n').length
        : 0
    const lineLength = line.isOpeningFence ? 0 : line.text.length
    const activeFenceOverhead =
      currentLang !== null || openingFenceSize > 0 ? closingFence.length : 0
    const wouldExceed =
      currentChunk.length + openingFenceSize + lineLength + activeFenceOverhead > maxLength

    if (wouldExceed) {
      // handle case where single line is longer than maxLength
      if (line.text.length > maxLength) {
        // first, flush current chunk if any
        if (currentChunk) {
          if (currentLang !== null) {
            currentChunk += '```\n'
          }
          chunks.push(currentChunk)
          currentChunk = ''
        }

        // calculate overhead for code block markers
        const codeBlockOverhead = line.inCodeBlock
          ? ('```' + line.lang + '\n').length + '```\n'.length
          : 0
        // ensure at least 10 chars available, even if maxLength is very small
        const availablePerChunk = Math.max(10, maxLength - codeBlockOverhead - 50)

        const pieces = splitLongLine(line.text, availablePerChunk, line.inCodeBlock)

        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i]!
          if (line.inCodeBlock) {
            chunks.push('```' + line.lang + '\n' + piece + '```\n')
          } else {
            chunks.push(piece)
          }
        }

        currentLang = null
        continue
      }

      // normal case: line fits in a chunk but current chunk would overflow
      if (currentChunk) {
        if (currentLang !== null) {
          currentChunk += '```\n'
        }
        chunks.push(currentChunk)

        if (line.isClosingFence && currentLang !== null) {
          currentChunk = ''
          currentLang = null
          continue
        }

        if (line.inCodeBlock || line.isOpeningFence) {
          const lang = line.lang
          currentChunk = '```' + lang + '\n'
          if (!line.isOpeningFence) {
            currentChunk += line.text
          }
          currentLang = lang
        } else {
          currentChunk = line.text
          currentLang = null
        }
      } else {
        // currentChunk is empty but line still exceeds - shouldn't happen after above check
        const openingFence = line.inCodeBlock || line.isOpeningFence
        const openingFenceSize = openingFence ? ('```' + line.lang + '\n').length : 0
        if (line.text.length + openingFenceSize + activeFenceOverhead > maxLength) {
          const fencedOverhead = openingFence
            ? ('```' + line.lang + '\n').length + closingFence.length
            : 0
          const availablePerChunk = Math.max(10, maxLength - fencedOverhead - 50)
          const pieces = splitLongLine(line.text, availablePerChunk, line.inCodeBlock)
          for (const piece of pieces) {
            if (openingFence) {
              chunks.push('```' + line.lang + '\n' + piece + closingFence)
            } else {
              chunks.push(piece)
            }
          }
          currentChunk = ''
          currentLang = null
        } else {
          if (openingFence) {
            currentChunk = '```' + line.lang + '\n'
            if (!line.isOpeningFence) {
              currentChunk += line.text
            }
            currentLang = line.lang
          } else {
            currentChunk = line.text
            currentLang = null
          }
        }
      }
    } else {
      currentChunk += line.text
      if (line.inCodeBlock || line.isOpeningFence) {
        currentLang = line.lang
      } else if (line.isClosingFence) {
        currentLang = null
      }
    }
  }

  if (currentChunk) {
    if (currentLang !== null) {
      currentChunk += closingFence
    }
    chunks.push(currentChunk)
  }

  return chunks
}

export async function sendThreadMessage(
  thread: ThreadChannel,
  content: string,
  options?: { flags?: number },
): Promise<Message> {
  const MAX_LENGTH = 2000

  content = formatMarkdownTables(content)
  content = unnestCodeBlocksFromLists(content)
  content = limitHeadingDepth(content)
  content = escapeBackticksInCodeBlocks(content)

  // If custom flags provided, send as single message (no chunking)
  if (options?.flags !== undefined) {
    return thread.send({ content, flags: options.flags })
  }

  const chunks = splitMarkdownForDiscord({ content, maxLength: MAX_LENGTH })

  if (chunks.length > 1) {
    discordLogger.log(`MESSAGE: Splitting ${content.length} chars into ${chunks.length} messages`)
  }

  let firstMessage: Message | undefined
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (!chunk) {
      continue
    }
    const message = await thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
    if (i === 0) {
      firstMessage = message
    }
  }

  return firstMessage!
}

export async function resolveTextChannel(
  channel: TextChannel | ThreadChannel | null | undefined,
): Promise<TextChannel | null> {
  if (!channel) {
    return null
  }

  if (channel.type === ChannelType.GuildText) {
    return channel as TextChannel
  }

  if (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  ) {
    const parentId = channel.parentId
    if (parentId) {
      const parent = await channel.guild.channels.fetch(parentId)
      if (parent?.type === ChannelType.GuildText) {
        return parent as TextChannel
      }
    }
  }

  return null
}

export function escapeDiscordFormatting(text: string): string {
  return text.replace(/```/g, '\\`\\`\\`').replace(/````/g, '\\`\\`\\`\\`')
}

export async function getKimakiMetadata(textChannel: TextChannel | null): Promise<{
  projectDirectory?: string
  channelAppId?: string
}> {
  if (!textChannel) {
    return {}
  }

  const channelConfig = await getChannelDirectory(textChannel.id)

  if (!channelConfig) {
    return {}
  }

  return {
    projectDirectory: channelConfig.directory,
    channelAppId: channelConfig.appId || undefined,
  }
}

/**
 * Upload files to a Discord thread/channel in a single message.
 * Sending all files in one message causes Discord to display images in a grid layout.
 */
export async function uploadFilesToDiscord({
  threadId,
  botToken,
  files,
}: {
  threadId: string
  botToken: string
  files: string[]
}): Promise<void> {
  if (files.length === 0) {
    return
  }

  // Build attachments array for all files
  const attachments = files.map((file, index) => ({
    id: index,
    filename: path.basename(file),
  }))

  const formData = new FormData()
  formData.append('payload_json', JSON.stringify({ attachments }))

  // Append each file with its array index, with correct MIME type for grid display
  files.forEach((file, index) => {
    const buffer = fs.readFileSync(file)
    const mimeType = mime.getType(file) || 'application/octet-stream'
    formData.append(`files[${index}]`, new Blob([buffer], { type: mimeType }), path.basename(file))
  })

  const response = await fetch(`https://discord.com/api/v10/channels/${threadId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Discord API error: ${response.status} - ${error}`)
  }
}
