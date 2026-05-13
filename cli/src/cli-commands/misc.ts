// File upload and TTS terminal commands for sharing local files into Discord threads.
import { goke } from 'goke'
import { z } from 'zod'
import { note } from '@clack/prompts'
import YAML from 'yaml'
import * as errore from 'errore'
import type { OpencodeClient, Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { Events, ActivityType, type PresenceStatusData, type Guild, Routes } from 'discord.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { createLogger, LogPrefix, initLogFile } from '../logger.js'
import { createDiscordClient, initDatabase, getChannelDirectory, initializeOpencodeForDirectory, createProjectChannels } from '../discord-bot.js'
import { getBotTokenWithMode, getThreadSession, getThreadIdBySessionId, getSessionEventSnapshot, createScheduledTask, listScheduledTasks, cancelScheduledTask, getScheduledTask, updateScheduledTask, getSessionStartSourcesBySessionIds, deleteChannelDirectoryById, findChannelsByDirectory, getAnyAudioApiKey } from '../database.js'
import { ShareMarkdown } from '../markdown.js'
import { parseSessionSearchPattern, findFirstSessionSearchHit, buildSessionSearchSnippet, getPartSearchTexts } from '../session-search.js'
import { formatWorktreeName, formatAutoWorktreeName } from '../commands/new-worktree.js'
import { WORKTREE_PREFIX } from '../commands/merge-worktree.js'
import type { ThreadStartMarker } from '../system-message.js'
import { buildOpencodeEventLogLine } from '../session-handler/opencode-session-event-log.js'
import { createDiscordRest } from '../discord-urls.js'
import { archiveThread, uploadFilesToDiscord, stripMentions } from '../discord-utils.js'
import { setDataDir, setProjectsDir, getDataDir, getProjectsDir } from '../config.js'
import { execAsync, validateWorktreeDirectory } from '../worktrees.js'
import { upgrade, getCurrentVersion } from '../upgrade.js'
import { getPromptPreview, parseSendAtValue, parseScheduledTaskPayload, serializeScheduledTaskPayload, type ScheduledTaskPayload } from '../task-schedule.js'
import {
  EXIT_NO_RESTART,
  formatMemberLookupUnavailableMessage,
  formatRelativeTime,
  formatTaskScheduleLine,
  isDiscordMemberLookupUnavailable,
  isGuildMemberSearchResult,
  isThreadChannelType,
  printDiscordInstallUrlAndExit,
  resolveBotCredentials,
  resolveDiscordUserOption,
  sendDiscordMessageWithOptionalAttachment,
} from '../cli-runner.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

cli
  .command(
    'upload-to-discord [...files]',
    'Upload files to a Discord thread for a session',
  )
  .option('-s, --session <sessionId>', 'OpenCode session ID')
  .action(async (files: string[], options: { session?: string }) => {
    try {
      const { session: sessionId } = options

      if (!sessionId) {
        cliLogger.error('Session ID is required. Use --session <sessionId>')
        process.exit(EXIT_NO_RESTART)
      }

      if (!files || files.length === 0) {
        cliLogger.error('At least one file path is required')
        process.exit(EXIT_NO_RESTART)
      }

      const resolvedFiles = files.map((f) => path.resolve(f))
      for (const file of resolvedFiles) {
        if (!fs.existsSync(file)) {
          cliLogger.error(`File not found: ${file}`)
          process.exit(EXIT_NO_RESTART)
        }
      }

      await initDatabase()

      const threadId = await getThreadIdBySessionId(sessionId)

      if (!threadId) {
        cliLogger.error(`No Discord thread found for session: ${sessionId}`)
        process.exit(EXIT_NO_RESTART)
      }

      const botRow = await getBotTokenWithMode()

      if (!botRow) {
        cliLogger.error(
          'No bot credentials found. Run `kimaki` first to set up the bot.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      cliLogger.log(`Uploading ${resolvedFiles.length} file(s)...`)

      await uploadFilesToDiscord({
        threadId: threadId,
        botToken: botRow.token,
        files: resolvedFiles,
      })

      cliLogger.log(`Uploaded ${resolvedFiles.length} file(s)!`)

      note(
        `Files uploaded to Discord thread!\n\nFiles: ${resolvedFiles.map((f) => path.basename(f)).join(', ')}`,
        '✅ Success',
      )

      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })


cli
  .command('tts [text]', 'Generate speech audio from text. Reads from stdin if no text given.')
  .option('-o, --output [path]', 'Output file path (default: speech.mp3)')
  .option('-v, --voice [voice]', 'Voice ID, defaults to alloy (OpenAI) or Kore (Gemini)')
  .option('-i, --instructions [text]', 'Style instructions, e.g. "Speak calmly" (OpenAI only)')
  .option('--speed [speed]', 'Speed multiplier 0.25-4.0 (OpenAI only)')
  .option('-p, --provider [provider]', 'openai or gemini (auto-detected from key)')
  .option('-k, --api-key [key]', 'API key (falls back to stored key or env var)')
  .action(async (text: string | undefined, options) => {
    const { generateSpeech } = await import('../voice.js')
    type SpeechProvider = import('../voice.js').SpeechProvider

    // Read from stdin if no positional text argument
    if (!text) {
      if (process.stdin.isTTY) {
        cliLogger.error('No text provided. Pass text as argument or pipe via stdin.')
        process.exit(EXIT_NO_RESTART)
      }
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer)
      }
      text = Buffer.concat(chunks).toString('utf-8').trim()
      if (!text) {
        cliLogger.error('Empty input from stdin.')
        process.exit(EXIT_NO_RESTART)
      }
    }

    await initDatabase()

    // Resolve API key: flag → DB → env
    let apiKey = options.apiKey
    let provider: SpeechProvider | undefined = options.provider === 'openai' || options.provider === 'gemini'
      ? options.provider
      : undefined

    if (!apiKey) {
      const stored = await getAnyAudioApiKey()
      if (stored) {
        apiKey = stored.apiKey
        provider = provider || stored.provider
      }
    }

    if (!apiKey) {
      if (process.env.OPENAI_API_KEY) {
        apiKey = process.env.OPENAI_API_KEY
        provider = provider || 'openai'
      } else if (process.env.GEMINI_API_KEY) {
        apiKey = process.env.GEMINI_API_KEY
        provider = provider || 'gemini'
      }
    }

    if (!apiKey) {
      cliLogger.error('No API key found. Use --api-key, set OPENAI_API_KEY/GEMINI_API_KEY, or run /transcription-key in Discord.')
      process.exit(EXIT_NO_RESTART)
    }

    const speed = options.speed ? Number(options.speed) : 1.25

    cliLogger.log(`Generating speech with ${provider || 'auto-detected provider'}...`)

    const result = await generateSpeech({
      text,
      voice: options.voice || undefined,
      apiKey,
      provider,
      instructions: options.instructions || undefined,
      speed,
    })

    if (result instanceof Error) {
      cliLogger.error(`Speech generation failed: ${result.message}`)
      process.exit(EXIT_NO_RESTART)
    }

    const ext = result.mediaType === 'audio/mp3' ? 'mp3' : 'wav'
    const outputPath = options.output || `speech.${ext}`
    const resolvedOutput = path.resolve(outputPath)

    await fs.promises.writeFile(resolvedOutput, result.audio)

    cliLogger.log(`Audio saved to ${resolvedOutput} (${(result.audio.length / 1024).toFixed(1)} KB)`)
    process.exit(0)
  })

export default cli
