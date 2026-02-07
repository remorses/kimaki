// Discord-specific utility functions.
// Handles markdown splitting for Discord's 2000-char limit, code block escaping,
// thread message sending, and channel metadata extraction from topic tags.

import { ChannelType, MessageFlags, PermissionsBitField, type GuildMember, type Message, type TextChannel, type ThreadChannel } from 'discord.js'
import { REST, Routes } from 'discord.js'
import { Lexer } from 'marked'
import { splitTablesFromMarkdown } from './format-tables.js'
import { getChannelDirectory } from './database.js'
import { limitHeadingDepth } from './limit-heading-depth.js'
import { unnestCodeBlocksFromLists } from './unnest-code-blocks.js'
import { createLogger, LogPrefix } from './logger.js'
import * as errore from 'errore'
import mime from 'mime'
import fs from 'node:fs'
import path from 'node:path'

const discordLogger = createLogger(LogPrefix.DISCORD)

/**
 * Centralized permission check for Kimaki bot access.
 * Returns true if the member has permission to use the bot:
 * - Server owner, Administrator, Manage Server, or "Kimaki" role (case-insensitive).
 * Returns false if member is null or has the "no-kimaki" role (overrides all).
 */
export function hasKimakiBotPermission(member: GuildMember | null): boolean {
  if (!member) {
    return false
  }
  const hasNoKimakiRole = member.roles.cache.some(
    (role) => role.name.toLowerCase() === 'no-kimaki',
  )
  if (hasNoKimakiRole) {
    return false
  }
  const isOwner = member.id === member.guild.ownerId
  const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator)
  const canManageServer = member.permissions.has(PermissionsBitField.Flags.ManageGuild)
  const hasKimakiRole = member.roles.cache.some(
    (role) => role.name.toLowerCase() === 'kimaki',
  )
  return isOwner || isAdmin || canManageServer || hasKimakiRole
}

/**
 * Check if the member has the "no-kimaki" role that blocks bot access.
 * Separate from hasKimakiBotPermission so callers can show a specific error message.
 */
export function hasNoKimakiRole(member: GuildMember | null): boolean {
  if (!member) {
    return false
  }
  return member.roles.cache.some(
    (role) => role.name.toLowerCase() === 'no-kimaki',
  )
}

/**
 * React to a thread's starter message with an emoji.
 * Thread ID equals the starter message ID in Discord.
 */
export async function reactToThread({
  rest,
  threadId,
  channelId,
  emoji,
}: {
  rest: REST
  threadId: string
  /** Parent channel ID where the thread starter message lives.
   * If not provided, fetches the thread info from Discord API to resolve it. */
  channelId?: string
  emoji: string
}): Promise<void> {
  const parentChannelId = await (async () => {
    if (channelId) {
      return channelId
    }
    // Fetch the thread to get its parent channel ID
    const threadResult = await errore.tryAsync(() => {
      return rest.get(Routes.channel(threadId)) as Promise<{ parent_id?: string }>
    })
    if (threadResult instanceof Error) {
      discordLogger.warn(`Failed to fetch thread ${threadId}:`, threadResult.message)
      return null
    }
    return threadResult.parent_id || null
  })()

  if (!parentChannelId) {
    discordLogger.warn(`Could not resolve parent channel for thread ${threadId}`)
    return
  }

  // React to the thread starter message in the parent channel.
  // Thread ID equals the starter message ID for threads created from messages.
  const result = await errore.tryAsync(() => {
    return rest.put(
      Routes.channelMessageOwnReaction(parentChannelId, threadId, encodeURIComponent(emoji)),
    )
  })
  if (result instanceof Error) {
    discordLogger.warn(`Failed to react to thread ${threadId} with ${emoji}:`, result.message)
  }
}

/** Remove Discord mentions from text so they don't appear in thread titles */
export function stripMentions(text: string): string {
  return text
    .replace(/<@!?\d+>/g, '') // user mentions
    .replace(/<@&\d+>/g, '') // role mentions
    .replace(/<#\d+>/g, '') // channel mentions
    .replace(/\s+/g, ' ')
    .trim()
}

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

  // Split content into text and CV2 component segments (tables → Container components)
  const segments = splitTablesFromMarkdown(content)
  const baseFlags = options?.flags ?? SILENT_MESSAGE_FLAGS

  let firstMessage: Message | undefined

  for (const segment of segments) {
    if (segment.type === 'components') {
      const message = await thread.send({
        components: segment.components,
        flags: MessageFlags.IsComponentsV2 | baseFlags,
      })
      if (!firstMessage) {
        firstMessage = message
      }
      continue
    }

    // Apply text transformations to text segments
    let text = segment.text
    text = unnestCodeBlocksFromLists(text)
    text = limitHeadingDepth(text)
    text = escapeBackticksInCodeBlocks(text)

    if (!text.trim()) {
      continue
    }

    // If custom flags provided, send as single message (no chunking)
    if (options?.flags !== undefined) {
      const message = await thread.send({ content: text, flags: options.flags })
      if (!firstMessage) {
        firstMessage = message
      }
      continue
    }

    const chunks = splitMarkdownForDiscord({ content: text, maxLength: MAX_LENGTH })

    if (chunks.length > 1) {
      discordLogger.log(`MESSAGE: Splitting ${text.length} chars into ${chunks.length} messages`)
    }

    for (const chunk of chunks) {
      if (!chunk) {
        continue
      }
      const message = await thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
      if (!firstMessage) {
        firstMessage = message
      }
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
