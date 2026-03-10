// Discord-specific utility functions.
// Handles markdown splitting for Discord's 2000-char limit, code block escaping,
// thread message sending, and channel metadata extraction from topic tags.

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { KimakiAdapter, PlatformChannel, PlatformThread } from './platform/types.js'
import { Lexer } from 'marked'
import { getChannelDirectory, getThreadWorktree } from './database.js'
import { createLogger, LogPrefix } from './logger.js'
import * as errore from 'errore'
import mime from 'mime'
import fs from 'node:fs'
import path from 'node:path'
import { PLATFORM_MESSAGE_FLAGS } from './platform/message-flags.js'

const discordLogger = createLogger(LogPrefix.DISCORD)

/**
 * React to a thread's starter message with an emoji.
 * Thread ID equals the starter message ID in Discord.
 */
export async function reactToThread({
  adapter,
  threadId,
  parentChannelId,
  emoji,
}: {
  adapter: KimakiAdapter
  threadId: string
  /** Parent channel ID where the thread starter message lives. */
  parentChannelId?: string
  emoji: string
}): Promise<void> {
  const threadHandle = await adapter.thread({
    threadId,
    parentId: parentChannelId,
  })
  if (!threadHandle) {
    discordLogger.warn(
      `Could not resolve thread for starter reaction: ${threadId}`,
    )
    return
  }

  const result = await errore.tryAsync({
    try: async () => {
      await threadHandle.addStarterReaction(emoji)
    },
    catch: (e) => {
      return new Error(`Failed to react to thread ${threadId}`, { cause: e })
    },
  })
  if (result instanceof Error) {
    discordLogger.warn(
      `Failed to react to thread ${threadId} with ${emoji}:`,
      result.message,
    )
  }
}

export async function archiveThread({
  adapter,
  threadId,
  parentChannelId,
  sessionId,
  client,
  archiveDelay = 0,
}: {
  adapter: KimakiAdapter
  threadId: string
  parentChannelId?: string
  sessionId?: string
  client?: OpencodeClient | null
  archiveDelay?: number
}): Promise<void> {
  await reactToThread({
    adapter,
    threadId,
    parentChannelId,
    emoji: '📁',
  })

  if (client && sessionId) {
    const updateResult = await errore.tryAsync({
      try: async () => {
        const sessionResponse = await client.session.get({
          sessionID: sessionId,
        })
        if (!sessionResponse.data) {
          return
        }
        const currentTitle = sessionResponse.data.title || ''
        const newTitle = currentTitle.startsWith('📁')
          ? currentTitle
          : `📁 ${currentTitle}`.trim()
        await client.session.update({
          sessionID: sessionId,
          title: newTitle,
        })
      },
      catch: (e) => new Error('Failed to update session title', { cause: e }),
    })
    if (updateResult instanceof Error) {
      discordLogger.warn(`[archive-thread] ${updateResult.message}`)
    }

    const abortResult = await errore.tryAsync({
      try: async () => {
        await client.session.abort({ sessionID: sessionId })
      },
      catch: (e) => new Error('Failed to abort session', { cause: e }),
    })
    if (abortResult instanceof Error) {
      discordLogger.warn(`[archive-thread] ${abortResult.message}`)
    }
  }

  if (archiveDelay > 0) {
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve()
      }, archiveDelay)
    })
  }

  const threadHandle = await adapter.thread({
    threadId,
    parentId: parentChannelId,
  })
  if (!threadHandle) {
    throw new Error(`Thread not found for archive: ${threadId}`)
  }
  await threadHandle.archive()
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

export const SILENT_MESSAGE_FLAGS =
  PLATFORM_MESSAGE_FLAGS.SUPPRESS_EMBEDS |
  PLATFORM_MESSAGE_FLAGS.SUPPRESS_NOTIFICATIONS
// Same as SILENT but without SuppressNotifications - triggers badge/notification
export const NOTIFY_MESSAGE_FLAGS = PLATFORM_MESSAGE_FLAGS.SUPPRESS_EMBEDS

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
  const splitLongLine = (
    text: string,
    available: number,
    inCode: boolean,
  ): string[] => {
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
    // openingFenceSize accounts for the fence text when starting a fresh chunk
    const openingFenceSize =
      currentChunk.length === 0 && (line.inCodeBlock || line.isOpeningFence)
        ? ('```' + line.lang + '\n').length
        : 0
    // When opening fence starts a fresh chunk, its size is in openingFenceSize.
    // Otherwise count it normally so the overflow check doesn't miss the fence text.
    const lineLength =
      line.isOpeningFence && currentChunk.length === 0 ? 0 : line.text.length
    const activeFenceOverhead =
      currentLang !== null || openingFenceSize > 0 ? closingFence.length : 0
    const wouldExceed =
      currentChunk.length +
        openingFenceSize +
        lineLength +
        activeFenceOverhead >
      maxLength

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
        const availablePerChunk = Math.max(
          10,
          maxLength - codeBlockOverhead - 50,
        )

        const pieces = splitLongLine(
          line.text,
          availablePerChunk,
          line.inCodeBlock,
        )

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
        const openingFenceSize = openingFence
          ? ('```' + line.lang + '\n').length
          : 0
        if (
          line.text.length + openingFenceSize + activeFenceOverhead >
          maxLength
        ) {
          const fencedOverhead = openingFence
            ? ('```' + line.lang + '\n').length + closingFence.length
            : 0
          const availablePerChunk = Math.max(
            10,
            maxLength - fencedOverhead - 50,
          )
          const pieces = splitLongLine(
            line.text,
            availablePerChunk,
            line.inCodeBlock,
          )
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

export function escapeDiscordFormatting(text: string): string {
  return text.replace(/```/g, '\\`\\`\\`').replace(/````/g, '\\`\\`\\`\\`')
}

/**
 * Resolve the working directory for a channel or thread.
 * Returns both the base project directory (for server init) and the working directory
 * (worktree directory if in a worktree thread, otherwise same as projectDirectory).
 * This prevents commands from accidentally running in the base project dir when a
 * worktree is active — the bug that caused /diff, /compact, etc. to use wrong cwd.
 */
export async function resolveWorkingDirectory({
  channel,
}: {
  channel: PlatformThread | PlatformChannel
}): Promise<
  | {
      projectDirectory: string
      workingDirectory: string
    }
  | undefined
> {
  const isThread = channel.kind === 'thread'
  const parentChannelId = isThread ? channel.parentId : channel.id
  if (!parentChannelId) {
    return undefined
  }

  const channelConfig = await getChannelDirectory(parentChannelId)
  const projectDirectory = channelConfig?.directory
  if (!projectDirectory) {
    return undefined
  }

  let workingDirectory = projectDirectory
  if (isThread) {
    const worktreeInfo = await getThreadWorktree(channel.id)
    if (worktreeInfo?.status === 'ready' && worktreeInfo.worktree_directory) {
      workingDirectory = worktreeInfo.worktree_directory
    }
  }

  return {
    projectDirectory,
    workingDirectory,
  }
}

/**
 * Upload files to a Discord thread/channel in a single message.
 * Sending all files in one message causes Discord to display images in a grid layout.
 */
export async function uploadFilesToDiscord({
  adapter,
  threadId,
  files,
}: {
  adapter: KimakiAdapter
  threadId: string
  files: string[]
}): Promise<void> {
  if (files.length === 0) {
    return
  }

  const attachments = files.map((file) => {
    const buffer = fs.readFileSync(file)
    const contentType = mime.getType(file) || 'application/octet-stream'
    return {
      filename: path.basename(file),
      contentType,
      data: buffer,
    }
  })
  await adapter.conversation({ channelId: threadId }).send({
    markdown: '\u200b',
    files: attachments,
  })
}
