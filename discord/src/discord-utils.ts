// Discord-specific utility functions.
// Handles markdown splitting for Discord's 2000-char limit, code block escaping,
// thread message sending, and channel metadata extraction from topic tags.

import { ChannelType, type Message, type TextChannel, type ThreadChannel } from 'discord.js'
import { Lexer } from 'marked'
import { extractTagsArrays } from './xml.js'
import { formatMarkdownTables } from './format-tables.js'
import { limitHeadingDepth } from './limit-heading-depth.js'
import { unnestCodeBlocksFromLists } from './unnest-code-blocks.js'
import { createLogger } from './logger.js'

const discordLogger = createLogger('DISCORD')

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
  for (const token of tokens) {
    if (token.type === 'code') {
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

  for (const line of lines) {
    const wouldExceed = currentChunk.length + line.text.length > maxLength

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
        currentChunk = line.text
        if (line.inCodeBlock || line.isOpeningFence) {
          currentLang = line.lang
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

export function getKimakiMetadata(textChannel: TextChannel | null): {
  projectDirectory?: string
  channelAppId?: string
} {
  if (!textChannel?.topic) {
    return {}
  }

  const extracted = extractTagsArrays({
    xml: textChannel.topic,
    tags: ['kimaki.directory', 'kimaki.app'],
  })

  const projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
  const channelAppId = extracted['kimaki.app']?.[0]?.trim()

  return { projectDirectory, channelAppId }
}
