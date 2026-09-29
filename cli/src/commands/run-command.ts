// /run-shell-command and the ! message prefix (e.g. "!ls -la").
// Runs a shell command in the project directory and streams its output to
// Discord while it runs. stdout and stderr are interleaved in arrival order.
//
// Output lives in one code block message that is edited in place on a
// throttled timer. When it no longer fits in 2000 chars the bot continues in a
// new message, up to MAX_PAGES messages. Past that, the last message shows the
// tail of the output. The exit code is a subtext line under the code block.
//
// Discord rate limits (see "discord rate limits" in AGENTS.md): message sends and
// edits share a per-channel bucket of about 5 requests per 5 seconds, so we
// flush at most once per FLUSH_INTERVAL_MS.

import { spawn } from 'node:child_process'
import * as errore from 'errore'
import {
  ChannelType,
  MessageFlags,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { stripAnsi } from '../utils.js'
import { asSubtext } from '../message-formatting.js'
import { formatDuration } from '../markdown.js'

const logger = createLogger(LogPrefix.INTERACTION)

const MAX_MESSAGE_CHARS = 2000
// Code fence + newline + footer line must fit next to the body.
const FOOTER_RESERVE_CHARS = 120
const CODE_FENCE_OVERHEAD = '```\n\n```'.length
const PAGE_BODY_CHARS =
  MAX_MESSAGE_CHARS - FOOTER_RESERVE_CHARS - CODE_FENCE_OVERHEAD
const MAX_PAGES = 5
const FLUSH_INTERVAL_MS = 1000
const COMMAND_TIMEOUT_MS = 10 * 60_000
const KILL_GRACE_MS = 5_000
// In-memory output is bounded so `yes` or a noisy build cannot grow forever.
const HEAD_BUFFER_CHARS = MAX_PAGES * MAX_MESSAGE_CHARS
const TAIL_BUFFER_CHARS = 2 * MAX_MESSAGE_CHARS

class ShellSpawnError extends errore.createTaggedError({
  name: 'ShellSpawnError',
  message: 'Could not start shell command in $directory',
}) {}

class ShellOutputDeliveryError extends errore.createTaggedError({
  name: 'ShellOutputDeliveryError',
  message: 'Could not $action shell output message $index',
}) {}

// ── output buffer ──────────────────────────────────────────────────────────

export type ShellOutputSnapshot = {
  output: string
  // Whole lines dropped from the middle to keep memory bounded.
  droppedLines: number
  // Some line in `output` lost characters when the buffer was trimmed.
  cutLines?: boolean
}

export function createShellOutputBuffer() {
  let head = ''
  let tail = ''
  let droppedNewlines = 0
  let trimmed = false
  let cutMidLine = false
  let headFull = false

  function append(chunk: string): void {
    if (!headFull) {
      const room = HEAD_BUFFER_CHARS - head.length
      if (chunk.length <= room) {
        head += chunk
        return
      }
      const take = headCutIndex({ head, chunk, room })
      head += chunk.slice(0, take)
      chunk = chunk.slice(take)
      headFull = true
    }
    tail += chunk
    if (tail.length <= TAIL_BUFFER_CHARS * 2) return
    // Cut at a line start so the kept tail begins with a whole line.
    const cutStart = tail.length - TAIL_BUFFER_CHARS
    const newlineIndex = tail.indexOf('\n', cutStart)
    if (newlineIndex === -1) cutMidLine = true
    const cut = newlineIndex === -1 ? cutStart : newlineIndex + 1
    droppedNewlines += countNewlines(tail.slice(0, cut))
    tail = tail.slice(cut)
    trimmed = true
  }

  function snapshot(): ShellOutputSnapshot {
    if (!trimmed) return { output: head + tail, droppedLines: 0 }
    const headEndsLine = head.endsWith('\n')
    // The first dropped newline completes the head's last partial line.
    const droppedLines = Math.max(0, droppedNewlines - (headEndsLine ? 0 : 1))
    return {
      output: head + (headEndsLine ? '' : '\n') + tail,
      droppedLines,
      // A head ending mid-line lost the rest of that line, unless nothing was dropped after it.
      cutLines: cutMidLine || (!headEndsLine && droppedNewlines > 0),
    }
  }

  return { append, snapshot }
}

// Close the head at a line end so a normal line is never split in two.
// Only lines longer than a message get cut mid-line.
function headCutIndex({ head, chunk, room }: { head: string; chunk: string; room: number }): number {
  const lastNewline = chunk.lastIndexOf('\n', room - 1)
  if (lastNewline !== -1) return lastNewline + 1
  if (head === '' || head.endsWith('\n')) {
    const firstNewline = chunk.indexOf('\n')
    return firstNewline !== -1 && firstNewline < MAX_MESSAGE_CHARS ? firstNewline + 1 : 0
  }
  const firstNewline = chunk.indexOf('\n')
  if (firstNewline !== -1 && firstNewline < room + MAX_MESSAGE_CHARS) return firstNewline + 1
  return room
}

function countNewlines(text: string): number {
  let count = 0
  for (const char of text) {
    if (char === '\n') count++
  }
  return count
}

// ── rendering ──────────────────────────────────────────────────────────────

// Terminal-like cleanup: strip ANSI colors, keep only the text after the last
// carriage return (progress bars), escape code fences so output can't close ours.
function normalizeOutputLines(output: string): string[] {
  const lines = stripAnsi(output)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const withoutTrailingCr = line.replace(/\r+$/, '')
      const visible = withoutTrailingCr.slice(
        withoutTrailingCr.lastIndexOf('\r') + 1,
      )
      return visible.replaceAll('```', '``\u200b`')
    })
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop()
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift()
  return lines
}

type LinePiece = { text: string; lineIndex: number }

function splitIntoPieces(lines: string[]): LinePiece[] {
  return lines.flatMap((line, lineIndex) => {
    if (line.length <= PAGE_BODY_CHARS) return [{ text: line, lineIndex }]
    const pieces: LinePiece[] = []
    for (let start = 0; start < line.length; start += PAGE_BODY_CHARS) {
      pieces.push({ text: line.slice(start, start + PAGE_BODY_CHARS), lineIndex })
    }
    return pieces
  })
}

function packPages(pieces: LinePiece[]): LinePiece[][] {
  const pages: LinePiece[][] = []
  let current: LinePiece[] = []
  let currentLength = 0
  for (const piece of pieces) {
    const added = current.length === 0 ? piece.text.length : piece.text.length + 1
    if (current.length > 0 && currentLength + added > PAGE_BODY_CHARS) {
      pages.push(current)
      current = [piece]
      currentLength = piece.text.length
      continue
    }
    current.push(piece)
    currentLength += added
  }
  if (current.length > 0) pages.push(current)
  return pages
}

function formatPage({ body, footer }: { body: string; footer?: string }): string {
  const block = `\`\`\`\n${body}\n\`\`\``
  return footer ? `${block}\n${footer}` : block
}

/**
 * Render streamed shell output as Discord message contents. Pure function:
 * the caller diffs the result against sent messages and edits what changed.
 * Earlier pages stay stable while output grows, so only the last one is edited.
 */
export function renderShellOutputPages({
  output,
  droppedLines,
  cutLines = false,
  footer,
}: ShellOutputSnapshot & { footer: string }): string[] {
  const lines = normalizeOutputLines(output)
  if (lines.length === 0 && droppedLines === 0) return [footer]

  const pieces = splitIntoPieces(lines)
  const pages = packPages(pieces)
  if (pages.length <= MAX_PAGES && droppedLines === 0 && !cutLines) {
    return pages.map((page, index) => {
      return formatPage({
        body: page.map((piece) => piece.text).join('\n'),
        footer: index === pages.length - 1 ? footer : undefined,
      })
    })
  }

  const headPages = pages.slice(0, MAX_PAGES - 1)
  const headPieceCount = headPages.reduce((sum, page) => sum + page.length, 0)
  const markerReserve = 40
  const tail: LinePiece[] = []
  let tailLength = 0
  for (let index = pieces.length - 1; index >= headPieceCount; index--) {
    const piece = pieces[index]!
    const added = piece.text.length + 1
    if (tailLength + added > PAGE_BODY_CHARS - markerReserve) break
    tail.unshift(piece)
    tailLength += added
  }
  const shownPieces = [...headPages.flat(), ...tail]
  const shownLines = new Set(shownPieces.map((piece) => piece.lineIndex))
  const hiddenLines = lines.length - shownLines.size + droppedLines
  // A line longer than a page can be split with only some pieces shown.
  const shownPieceSet = new Set(shownPieces)
  const hasPartialLine = cutLines || pieces.some((piece) => {
    return shownLines.has(piece.lineIndex) && !shownPieceSet.has(piece)
  })
  const marker = `... ${[
    hiddenLines > 0 ? `${hiddenLines} ${hiddenLines === 1 ? 'line' : 'lines'} hidden` : '',
    hasPartialLine ? 'long lines cut' : '',
  ].filter(Boolean).join(', ')}`
  const tailBody = [marker, ...tail.map((piece) => piece.text)].join('\n')

  return [
    ...headPages.map((page) => {
      return formatPage({ body: page.map((piece) => piece.text).join('\n') })
    }),
    formatPage({ body: tailBody, footer }),
  ]
}

// ── process ────────────────────────────────────────────────────────────────

type ShellExit = {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
}

function runStreamingShell({
  command,
  directory,
  onOutput,
}: {
  command: string
  directory: string
  onOutput: (chunk: string) => void
}): Promise<ShellSpawnError | ShellExit> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    // `exec 2>&1` sends stderr into the stdout pipe so lines keep terminal order.
    // Two separate pipes would race in the event loop. detached: own process
    // group, so a timeout kills the whole pipeline.
    const child = spawn(`exec 2>&1\n${command}`, {
      cwd: directory,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let timedOut = false
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      const groupKill = errore.try(() => process.kill(-child.pid!, signal))
      if (groupKill instanceof Error) child.kill(signal)
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
    }, COMMAND_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onOutput)
    child.stderr.on('data', onOutput)

    child.on('error', (error) => {
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      resolve(new ShellSpawnError({ directory, cause: error }))
    })
    child.on('close', (code, signal) => {
      // Keep killTimer: the shell can exit on SIGTERM while a descendant that
      // closed its pipes ignores it. SIGKILL on a gone group is a no-op.
      clearTimeout(timeoutTimer)
      resolve({ code, signal, timedOut, durationMs: Date.now() - startedAt })
    })
  })
}

function formatExitFooter(result: ShellSpawnError | ShellExit): string {
  if (result instanceof Error) {
    const reason = result.cause instanceof Error ? result.cause.message : result.message
    return asSubtext(`failed to start ⋅ ${reason.split('\n')[0]!.slice(0, 80)}`)
  }
  const duration = formatDuration(result.durationMs)
  if (result.timedOut) {
    return asSubtext(`timed out after ${formatDuration(COMMAND_TIMEOUT_MS)} ⋅ killed`)
  }
  if (result.signal) return asSubtext(`killed by ${result.signal} ⋅ ${duration}`)
  return asSubtext(`exit ${result.code ?? 1} ⋅ ${duration}`)
}

// ── Discord streaming ──────────────────────────────────────────────────────

export type ShellOutputPage = {
  edit: (content: string) => Promise<unknown>
  delete: () => Promise<unknown>
}

/**
 * Run a command and stream its output into Discord messages created by
 * `sendPage`. Page 0 is sent right away with a "running" footer.
 */
export async function streamShellCommand({
  command,
  directory,
  sendPage,
}: {
  command: string
  directory: string
  sendPage: (args: { index: number; content: string }) => Promise<ShellOutputPage>
}): Promise<void> {
  const buffer = createShellOutputBuffer()
  const sent: { page: ShellOutputPage; content: string }[] = []
  let footer = asSubtext('running...')

  // Stops at the first failure so later pages never appear before a missing
  // earlier one. Failed pages keep their old content, so the next sync retries.
  const syncPages = async (): Promise<ShellOutputDeliveryError | undefined> => {
    const contents = renderShellOutputPages({ ...buffer.snapshot(), footer })
    for (const [index, content] of contents.entries()) {
      const existing = sent[index]
      if (existing?.content === content) continue
      if (existing) {
        const edited = await existing.page.edit(content).then(
          () => null,
          (cause) => new ShellOutputDeliveryError({ action: 'edit', index: String(index), cause }),
        )
        if (edited instanceof Error) return edited
        existing.content = content
        continue
      }
      const page = await sendPage({ index, content }).catch((cause) => {
        return new ShellOutputDeliveryError({ action: 'send', index: String(index), cause })
      })
      if (page instanceof Error) return page
      sent.push({ page, content })
    }
    // A carriage-return rewrite can shrink output into fewer pages.
    while (sent.length > contents.length) {
      const stale = sent.at(-1)!
      const deleted = await stale.page.delete().then(
        () => null,
        (cause) => new ShellOutputDeliveryError({ action: 'delete', index: String(sent.length - 1), cause }),
      )
      if (deleted instanceof Error) return deleted
      sent.pop()
    }
    return undefined
  }
  const syncPagesLogged = async () => {
    const error = await syncPages()
    if (error) logger.warn(`[RUN-COMMAND] ${error.message}:`, error.cause)
    return error
  }

  // Serialized syncs. At most one queued sync; it reads the latest state when it starts.
  let syncChain: Promise<ShellOutputDeliveryError | undefined> = Promise.resolve(undefined)
  let syncQueued = false
  const queueSync = () => {
    if (syncQueued) return syncChain
    syncQueued = true
    syncChain = syncChain.then(() => {
      syncQueued = false
      return syncPagesLogged()
    })
    return syncChain
  }

  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleSync = () => {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void queueSync()
    }, FLUSH_INTERVAL_MS)
  }

  logger.log(`[RUN-COMMAND] Running "${command}" in ${directory}`)
  void queueSync()
  const result = await runStreamingShell({
    command,
    directory,
    onOutput: (chunk) => {
      buffer.append(chunk)
      scheduleSync()
    },
  })
  clearTimeout(flushTimer)
  flushTimer = undefined

  if (result instanceof Error) {
    logger.error(`[RUN-COMMAND] ${result.message}:`, result.cause)
  } else {
    logger.log(
      `[RUN-COMMAND] "${command}" finished: code=${result.code} signal=${result.signal} timedOut=${result.timedOut}`,
    )
  }
  footer = formatExitFooter(result)
  const finalSync = await queueSync()
  if (!finalSync) return
  // Output messages could not be updated. Post the exit status on its own so
  // the thread does not show "running..." forever.
  const fallback = await sendPage({
    index: Math.max(1, sent.length),
    content: `${footer} ⋅ output message could not be updated`,
  }).catch((cause) => {
    return new ShellOutputDeliveryError({ action: 'send', index: 'fallback', cause })
  })
  if (fallback instanceof Error) {
    logger.warn(`[RUN-COMMAND] ${fallback.message}:`, fallback.cause)
  }
}

/** Run a `!command` message. Output replies to the message, overflow continues in the channel. */
export async function runShellCommandForMessage({
  message,
  command,
  directory,
}: {
  message: Message
  command: string
  directory: string
}) {
  const channel = message.channel
  return streamShellCommand({
    command,
    directory,
    sendPage: async ({ index, content }) => {
      const options = {
        content,
        flags: SILENT_MESSAGE_FLAGS,
        allowedMentions: { parse: [], repliedUser: false },
      }
      if (index === 0) return message.reply(options)
      if (!channel.isSendable()) {
        throw new Error('Channel is not sendable')
      }
      return channel.send(options)
    },
  })
}

/**
 * Run a shell command posted in Discord: `!cmd` messages, action buttons
 * with a `command` and queued `!cmd. queue` messages. Output replies to
 * `replyToMessageId`, overflow continues in the channel.
 */
export async function runShellCommandInChannel({
  channel,
  replyToMessageId,
  command,
  directory,
}: {
  channel: TextChannel | ThreadChannel
  replyToMessageId?: string
  command: string
  directory: string
}): Promise<void> {
  await streamShellCommand({
    command,
    directory,
    sendPage: async ({ index, content }) => {
      return channel.send({
        content,
        flags: SILENT_MESSAGE_FLAGS,
        allowedMentions: { parse: [], repliedUser: false },
        reply: index === 0 && replyToMessageId
          ? { messageReference: replyToMessageId, failIfNotExists: false }
          : undefined,
      })
    },
  })
}

export async function handleRunCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel.',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  const isTextChannel = channel.type === ChannelType.GuildText

  if (!isThread && !isTextChannel) {
    await command.reply({
      content: 'This command can only be used in a text channel or thread.',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel.',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const input = command.options.getString('command', true)

  await command.deferReply()

  // Interaction webhook routes: works through gateway-proxy without channel scope.
  // Tokens expire after 15 minutes, longer than COMMAND_TIMEOUT_MS.
  await streamShellCommand({
    command: input,
    directory: resolved.workingDirectory,
    sendPage: async ({ index, content }) => {
      const allowedMentions = { parse: [] }
      if (index === 0) {
        await command.editReply({ content, allowedMentions })
        return {
          edit: (next) => command.editReply({ content: next, allowedMentions }),
          delete: () => command.deleteReply(),
        }
      }
      const followUp = await command.followUp({
        content,
        allowedMentions,
        flags: SILENT_MESSAGE_FLAGS,
      })
      return {
        edit: (next) => {
          return command.editReply({ content: next, allowedMentions, message: followUp.id })
        },
        delete: () => command.deleteReply(followUp.id),
      }
    },
  })
}
