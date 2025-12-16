import {
  createOpencodeClient,
  type OpencodeClient,
  type Part,
  type Config,
  type FilePartInput,
  type Permission,
} from '@opencode-ai/sdk'

import { createGenAIWorker, type GenAIWorker } from './genai-worker-wrapper.js'

import Database from 'better-sqlite3'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ThreadAutoArchiveDuration,
  type CategoryChannel,
  type Guild,
  type Interaction,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type VoiceChannel,
} from 'discord.js'
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
  type VoiceConnection,
} from '@discordjs/voice'
import { Lexer } from 'marked'
import { spawn, exec, type ChildProcess } from 'node:child_process'
import fs, { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { PassThrough, Transform, type TransformCallback } from 'node:stream'
import * as prism from 'prism-media'
import dedent from 'string-dedent'
import { transcribeAudio } from './voice.js'
import { extractTagsArrays, extractNonXmlContent } from './xml.js'
import prettyMilliseconds from 'pretty-ms'
import type { Session } from '@google/genai'
import { createLogger } from './logger.js'
import { isAbortError } from './utils.js'
import { setGlobalDispatcher, Agent } from 'undici'
// disables the automatic 5 minutes abort after no body
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))

type ParsedCommand = {
  isCommand: true
  command: string
  arguments: string
} | {
  isCommand: false
}

function parseSlashCommand(text: string): ParsedCommand {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) {
    return { isCommand: false }
  }
  const match = trimmed.match(/^\/(\S+)(?:\s+(.*))?$/)
  if (!match) {
    return { isCommand: false }
  }
  const command = match[1]!
  const args = match[2]?.trim() || ''
  return { isCommand: true, command, arguments: args }
}

export function getOpencodeSystemMessage({ sessionId }: { sessionId: string }) {
  return `
The user is reading your messages from inside Discord, via kimaki.xyz

Your current OpenCode session ID is: ${sessionId}

## uploading files to discord

To upload files to the Discord thread (images, screenshots, long files that would clutter the chat), run:

npx -y kimaki upload-to-discord --session ${sessionId} <file1> [file2] ...

## showing diffs

After each message, if you implemented changes, you can show the user a diff via an url running the command, to show the changes in working directory:

bunx critique web

you can also show latest commit changes using

bunx critique web HEAD~1

do this in case you committed the changes yourself (only if the user asks so, never commit otherwise).

## markdown

discord does support basic markdown features like code blocks, code blocks languages, inline code, bold, italic, quotes, etc.

the max heading level is 3, so do not use ####

headings are discouraged anyway. instead try to use bold text for titles which renders more nicely in Discord

## tables

discord does NOT support markdown gfm tables.

so instead of using full markdown tables ALWAYS show code snippets with space aligned cells:

\`\`\`
Item        Qty   Price
----------  ---   -----
Apples      10    $5
Oranges     3     $2
\`\`\`

Using code blocks will make the content use monospaced font so that space will be aligned correctly

IMPORTANT: add enough space characters to align the table! otherwise the content will not look good and will be difficult to understand for the user

code blocks for tables and diagrams MUST have Max length of 85 characters. otherwise the content will wrap

## diagrams

you can create diagrams wrapping them in code blocks too.
`
}

const discordLogger = createLogger('DISCORD')
const voiceLogger = createLogger('VOICE')
const opencodeLogger = createLogger('OPENCODE')
const sessionLogger = createLogger('SESSION')
const dbLogger = createLogger('DB')

type StartOptions = {
  token: string
  appId?: string
}

// Map of project directory to OpenCode server process and client
const opencodeServers = new Map<
  string,
  {
    process: ChildProcess
    client: OpencodeClient
    port: number
  }
>()

// Map of session ID to current AbortController
const abortControllers = new Map<string, AbortController>()

// Map of guild ID to voice connection and GenAI worker
const voiceConnections = new Map<
  string,
  {
    connection: VoiceConnection
    genAiWorker?: GenAIWorker
    userAudioStream?: fs.WriteStream
  }
>()

// Map of directory to retry count for server restarts
const serverRetryCount = new Map<string, number>()

// Map of thread ID to pending permission (only one pending permission per thread)
const pendingPermissions = new Map<
  string,
  { permission: Permission; messageId: string; directory: string }
>()

let db: Database.Database | null = null

function convertToMono16k(buffer: Buffer): Buffer {
  // Parameters
  const inputSampleRate = 48000
  const outputSampleRate = 16000
  const ratio = inputSampleRate / outputSampleRate
  const inputChannels = 2 // Stereo
  const bytesPerSample = 2 // 16-bit

  // Calculate output buffer size
  const inputSamples = buffer.length / (bytesPerSample * inputChannels)
  const outputSamples = Math.floor(inputSamples / ratio)
  const outputBuffer = Buffer.alloc(outputSamples * bytesPerSample)

  // Process each output sample
  for (let i = 0; i < outputSamples; i++) {
    // Find the corresponding input sample
    const inputIndex = Math.floor(i * ratio) * inputChannels * bytesPerSample

    // Average the left and right channels for mono conversion
    if (inputIndex + 3 < buffer.length) {
      const leftSample = buffer.readInt16LE(inputIndex)
      const rightSample = buffer.readInt16LE(inputIndex + 2)
      const monoSample = Math.round((leftSample + rightSample) / 2)

      // Write to output buffer
      outputBuffer.writeInt16LE(monoSample, i * bytesPerSample)
    }
  }

  return outputBuffer
}

// Create user audio log stream for debugging
async function createUserAudioLogStream(
  guildId: string,
  channelId: string,
): Promise<fs.WriteStream | undefined> {
  if (!process.env.DEBUG) return undefined

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const audioDir = path.join(
    process.cwd(),
    'discord-audio-logs',
    guildId,
    channelId,
  )

  try {
    await mkdir(audioDir, { recursive: true })

    // Create stream for user audio (16kHz mono s16le PCM)
    const inputFileName = `user_${timestamp}.16.pcm`
    const inputFilePath = path.join(audioDir, inputFileName)
    const inputAudioStream = createWriteStream(inputFilePath)
    voiceLogger.log(`Created user audio log: ${inputFilePath}`)

    return inputAudioStream
  } catch (error) {
    voiceLogger.error('Failed to create audio log directory:', error)
    return undefined
  }
}

// Set up voice handling for a connection (called once per connection)
async function setupVoiceHandling({
  connection,
  guildId,
  channelId,
  appId,
  discordClient,
}: {
  connection: VoiceConnection
  guildId: string
  channelId: string
  appId: string
  discordClient: Client
}) {
  voiceLogger.log(
    `Setting up voice handling for guild ${guildId}, channel ${channelId}`,
  )

  // Check if this voice channel has an associated directory
  const channelDirRow = getDatabase()
    .prepare(
      'SELECT directory FROM channel_directories WHERE channel_id = ? AND channel_type = ?',
    )
    .get(channelId, 'voice') as { directory: string } | undefined

  if (!channelDirRow) {
    voiceLogger.log(
      `Voice channel ${channelId} has no associated directory, skipping setup`,
    )
    return
  }

  const directory = channelDirRow.directory
  voiceLogger.log(`Found directory for voice channel: ${directory}`)

  // Get voice data
  const voiceData = voiceConnections.get(guildId)
  if (!voiceData) {
    voiceLogger.error(`No voice data found for guild ${guildId}`)
    return
  }

  // Create user audio stream for debugging
  voiceData.userAudioStream = await createUserAudioLogStream(guildId, channelId)

  // Get API keys from database
  const apiKeys = getDatabase()
    .prepare('SELECT gemini_api_key FROM bot_api_keys WHERE app_id = ?')
    .get(appId) as { gemini_api_key: string | null } | undefined

  // Create GenAI worker
  const genAiWorker = await createGenAIWorker({
    directory,
    guildId,
    channelId,
    appId,
    geminiApiKey: apiKeys?.gemini_api_key,
    systemMessage: dedent`
    You are Kimaki, an AI similar to Jarvis: you help your user (an engineer) controlling his coding agent, just like Jarvis controls Ironman armor and machines. Speak fast.

    You should talk like Jarvis, British accent, satirical, joking and calm. Be short and concise. Speak fast.

    After tool calls give a super short summary of the assistant message, you should say what the assistant message writes.

    Before starting a new session ask for confirmation if it is not clear if the user finished describing it. ask "message ready, send?"

    NEVER repeat the whole tool call parameters or message.

    Your job is to manage many opencode agent chat instances. Opencode is the agent used to write the code, it is similar to Claude Code.

    For everything the user asks it is implicit that the user is asking for you to proxy the requests to opencode sessions.

    You can
    - start new chats on a given project
    - read the chats to report progress to the user
    - submit messages to the chat
    - list files for a given projects, so you can translate imprecise user prompts to precise messages that mention filename paths using @

    Common patterns
    - to get the last session use the listChats tool
    - when user asks you to do something you submit a new session to do it. it's implicit that you proxy requests to the agents chat!
    - when you submit a session assume the session will take a minute or 2 to complete the task

    Rules
    - never spell files by mentioning dots, letters, etc. instead give a brief description of the filename
    - NEVER spell hashes or IDs
    - never read session ids or other ids

    Your voice is calm and monotone, NEVER excited and goofy. But you speak without jargon or bs and do veiled short jokes.
    You speak like you knew something other don't. You are cool and cold.
    `,
    onAssistantOpusPacket(packet) {
      // Opus packets are sent at 20ms intervals from worker, play directly
      if (connection.state.status !== VoiceConnectionStatus.Ready) {
        voiceLogger.log('Skipping packet: connection not ready')
        return
      }

      try {
        connection.setSpeaking(true)
        connection.playOpusPacket(Buffer.from(packet))
      } catch (error) {
        voiceLogger.error('Error sending packet:', error)
      }
    },
    onAssistantStartSpeaking() {
      voiceLogger.log('Assistant started speaking')
      connection.setSpeaking(true)
    },
    onAssistantStopSpeaking() {
      voiceLogger.log('Assistant stopped speaking (natural finish)')
      connection.setSpeaking(false)
    },
    onAssistantInterruptSpeaking() {
      voiceLogger.log('Assistant interrupted while speaking')
      genAiWorker.interrupt()
      connection.setSpeaking(false)
    },
    onToolCallCompleted(params) {
      const text = params.error
        ? `<systemMessage>\nThe coding agent encountered an error while processing session ${params.sessionId}: ${params.error?.message || String(params.error)}\n</systemMessage>`
        : `<systemMessage>\nThe coding agent finished working on session ${params.sessionId}\n\nHere's what the assistant wrote:\n${params.markdown}\n</systemMessage>`

      genAiWorker.sendTextInput(text)
    },
    async onError(error) {
      voiceLogger.error('GenAI worker error:', error)
      const textChannelRow = getDatabase()
        .prepare(
          `SELECT cd2.channel_id FROM channel_directories cd1
           JOIN channel_directories cd2 ON cd1.directory = cd2.directory
           WHERE cd1.channel_id = ? AND cd1.channel_type = 'voice' AND cd2.channel_type = 'text'`,
        )
        .get(channelId) as { channel_id: string } | undefined

      if (textChannelRow) {
        try {
          const textChannel = await discordClient.channels.fetch(
            textChannelRow.channel_id,
          )
          if (textChannel?.isTextBased() && 'send' in textChannel) {
            await textChannel.send(`⚠️ Voice session error: ${error}`)
          }
        } catch (e) {
          voiceLogger.error('Failed to send error to text channel:', e)
        }
      }
    },
  })

  // Stop any existing GenAI worker before storing new one
  if (voiceData.genAiWorker) {
    voiceLogger.log('Stopping existing GenAI worker before creating new one')
    await voiceData.genAiWorker.stop()
  }

  // Send initial greeting
  genAiWorker.sendTextInput(
    `<systemMessage>\nsay "Hello boss, how we doing today?"\n</systemMessage>`,
  )

  voiceData.genAiWorker = genAiWorker

  // Set up voice receiver for user input
  const receiver = connection.receiver

  // Remove all existing listeners to prevent accumulation
  receiver.speaking.removeAllListeners('start')

  // Counter to track overlapping speaking sessions
  let speakingSessionCount = 0

  receiver.speaking.on('start', (userId) => {
    voiceLogger.log(`User ${userId} started speaking`)

    // Increment session count for this new speaking session
    speakingSessionCount++
    const currentSessionCount = speakingSessionCount
    voiceLogger.log(`Speaking session ${currentSessionCount} started`)

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
    })

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    })

    // Add error handler to prevent crashes from corrupted data
    decoder.on('error', (error) => {
      voiceLogger.error(`Opus decoder error for user ${userId}:`, error)
    })

    // Transform to downsample 48k stereo -> 16k mono
    const downsampleTransform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          const downsampled = convertToMono16k(chunk)
          callback(null, downsampled)
        } catch (error) {
          callback(error as Error)
        }
      },
    })

    const framer = frameMono16khz()

    const pipeline = audioStream
      .pipe(decoder)
      .pipe(downsampleTransform)
      .pipe(framer)

    pipeline
      .on('data', (frame: Buffer) => {
        // Check if a newer speaking session has started
        if (currentSessionCount !== speakingSessionCount) {
          // voiceLogger.log(
          //   `Skipping audio frame from session ${currentSessionCount} because newer session ${speakingSessionCount} has started`,
          // )
          return
        }

        if (!voiceData.genAiWorker) {
          voiceLogger.warn(
            `[VOICE] Received audio frame but no GenAI worker active for guild ${guildId}`,
          )
          return
        }
        // voiceLogger.debug('User audio chunk length', frame.length)

        // Write to PCM file if stream exists
        voiceData.userAudioStream?.write(frame)

        // stream incrementally — low latency
        voiceData.genAiWorker.sendRealtimeInput({
          audio: {
            mimeType: 'audio/pcm;rate=16000',
            data: frame.toString('base64'),
          },
        })
      })
      .on('end', () => {
        // Only send audioStreamEnd if this is still the current session
        if (currentSessionCount === speakingSessionCount) {
          voiceLogger.log(
            `User ${userId} stopped speaking (session ${currentSessionCount})`,
          )
          voiceData.genAiWorker?.sendRealtimeInput({
            audioStreamEnd: true,
          })
        } else {
          voiceLogger.log(
            `User ${userId} stopped speaking (session ${currentSessionCount}), but skipping audioStreamEnd because newer session ${speakingSessionCount} exists`,
          )
        }
      })
      .on('error', (error) => {
        voiceLogger.error(`Pipeline error for user ${userId}:`, error)
      })

    // Also add error handlers to individual stream components
    audioStream.on('error', (error) => {
      voiceLogger.error(`Audio stream error for user ${userId}:`, error)
    })

    downsampleTransform.on('error', (error) => {
      voiceLogger.error(`Downsample transform error for user ${userId}:`, error)
    })

    framer.on('error', (error) => {
      voiceLogger.error(`Framer error for user ${userId}:`, error)
    })
  })
}

function frameMono16khz(): Transform {
  // Hardcoded: 16 kHz, mono, 16-bit PCM, 20 ms -> 320 samples -> 640 bytes
  const FRAME_BYTES =
    (100 /*ms*/ * 16_000 /*Hz*/ * 1 /*channels*/ * 2) /*bytes per sample*/ /
    1000
  let stash: Buffer = Buffer.alloc(0)
  let offset = 0

  return new Transform({
    readableObjectMode: false,
    writableObjectMode: false,

    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      // Normalize stash so offset is always 0 before appending
      if (offset > 0) {
        // Drop already-consumed prefix without copying the rest twice
        stash = stash.subarray(offset)
        offset = 0
      }

      // Append new data (single concat per incoming chunk)
      stash = stash.length ? Buffer.concat([stash, chunk]) : chunk

      // Emit as many full 20 ms frames as we can
      while (stash.length - offset >= FRAME_BYTES) {
        this.push(stash.subarray(offset, offset + FRAME_BYTES))
        offset += FRAME_BYTES
      }

      // If everything was consumed exactly, reset to empty buffer
      if (offset === stash.length) {
        stash = Buffer.alloc(0)
        offset = 0
      }

      cb()
    },

    flush(cb: TransformCallback) {
      // We intentionally drop any trailing partial (< 20 ms) to keep framing strict.
      // If you prefer to emit it, uncomment the next line:
      // if (stash.length - offset > 0) this.push(stash.subarray(offset));
      stash = Buffer.alloc(0)
      offset = 0
      cb()
    },
  })
}

export function getDatabase(): Database.Database {
  if (!db) {
    const kimakiDir = path.join(os.homedir(), '.kimaki')

    try {
      fs.mkdirSync(kimakiDir, { recursive: true })
    } catch (error) {
      dbLogger.error('Failed to create ~/.kimaki directory:', error)
    }

    const dbPath = path.join(kimakiDir, 'discord-sessions.db')

    dbLogger.log(`Opening database at: ${dbPath}`)
    db = new Database(dbPath)

    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_sessions (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS part_messages (
        part_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_tokens (
        app_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_directories (
        channel_id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_api_keys (
        app_id TEXT PRIMARY KEY,
        gemini_api_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
  }

  return db
}

export async function ensureKimakiCategory(guild: Guild): Promise<CategoryChannel> {
  const existingCategory = guild.channels.cache.find(
    (channel): channel is CategoryChannel => {
      if (channel.type !== ChannelType.GuildCategory) {
        return false
      }

      return channel.name.toLowerCase() === 'kimaki'
    },
  )

  if (existingCategory) {
    return existingCategory
  }

  return guild.channels.create({
    name: 'Kimaki',
    type: ChannelType.GuildCategory,
  })
}

export async function createProjectChannels({
  guild,
  projectDirectory,
  appId,
}: {
  guild: Guild
  projectDirectory: string
  appId: string
}): Promise<{ textChannelId: string; voiceChannelId: string; channelName: string }> {
  const baseName = path.basename(projectDirectory)
  const channelName = `${baseName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 100)

  const kimakiCategory = await ensureKimakiCategory(guild)

  const textChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: kimakiCategory,
    topic: `<kimaki><directory>${projectDirectory}</directory><app>${appId}</app></kimaki>`,
  })

  const voiceChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: kimakiCategory,
  })

  getDatabase()
    .prepare(
      'INSERT OR REPLACE INTO channel_directories (channel_id, directory, channel_type) VALUES (?, ?, ?)',
    )
    .run(textChannel.id, projectDirectory, 'text')

  getDatabase()
    .prepare(
      'INSERT OR REPLACE INTO channel_directories (channel_id, directory, channel_type) VALUES (?, ?, ?)',
    )
    .run(voiceChannel.id, projectDirectory, 'voice')

  return {
    textChannelId: textChannel.id,
    voiceChannelId: voiceChannel.id,
    channelName,
  }
}

async function getOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => {
          resolve(port)
        })
      } else {
        reject(new Error('Failed to get port'))
      }
    })
    server.on('error', reject)
  })
}

/**
 * Send a message to a Discord thread, automatically splitting long messages
 * @param thread - The thread channel to send to
 * @param content - The content to send (can be longer than 2000 chars)
 * @returns The first message sent
 */
async function sendThreadMessage(
  thread: ThreadChannel,
  content: string,
): Promise<Message> {
  const MAX_LENGTH = 2000

  content = escapeBackticksInCodeBlocks(content)

  const chunks = splitMarkdownForDiscord({ content, maxLength: MAX_LENGTH })

  if (chunks.length > 1) {
    discordLogger.log(
      `MESSAGE: Splitting ${content.length} chars into ${chunks.length} messages`,
    )
  }

  let firstMessage: Message | undefined
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (!chunk) {
      continue
    }
    const message = await thread.send(chunk)
    if (i === 0) {
      firstMessage = message
    }
  }

  return firstMessage!
}

async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const endpoints = [
        `http://localhost:${port}/api/health`,
        `http://localhost:${port}/`,
        `http://localhost:${port}/api`,
      ]

      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint)
          if (response.status < 500) {
            opencodeLogger.log(`Server ready on port `)
            return true
          }
        } catch (e) {}
      }
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(
    `Server did not start on port ${port} after ${maxAttempts} seconds`,
  )
}

async function processVoiceAttachment({
  message,
  thread,
  projectDirectory,
  isNewThread = false,
  appId,
}: {
  message: Message
  thread: ThreadChannel
  projectDirectory?: string
  isNewThread?: boolean
  appId?: string
}): Promise<string | null> {
  const audioAttachment = Array.from(message.attachments.values()).find(
    (attachment) => attachment.contentType?.startsWith('audio/'),
  )

  if (!audioAttachment) return null

  voiceLogger.log(
    `Detected audio attachment: ${audioAttachment.name} (${audioAttachment.contentType})`,
  )

  await message.react('⏳')
  await sendThreadMessage(thread, '🎤 Transcribing voice message...')

  const audioResponse = await fetch(audioAttachment.url)
  const audioBuffer = Buffer.from(await audioResponse.arrayBuffer())

  voiceLogger.log(`Downloaded ${audioBuffer.length} bytes, transcribing...`)

  // Get project file tree for context if directory is provided
  let transcriptionPrompt = 'Discord voice message transcription'

  if (projectDirectory) {
    try {
      voiceLogger.log(`Getting project file tree from ${projectDirectory}`)
      // Use git ls-files to get tracked files, then pipe to tree
      const execAsync = promisify(exec)
      const { stdout } = await execAsync('git ls-files | tree --fromfile -a', {
        cwd: projectDirectory,
      })
      const result = stdout

      if (result) {
        transcriptionPrompt = `Discord voice message transcription. Project file structure:\n${result}\n\nPlease transcribe file names and paths accurately based on this context.`
        voiceLogger.log(`Added project context to transcription prompt`)
      }
    } catch (e) {
      voiceLogger.log(`Could not get project tree:`, e)
    }
  }

  // Get Gemini API key from database if appId is provided
  let geminiApiKey: string | undefined
  if (appId) {
    const apiKeys = getDatabase()
      .prepare('SELECT gemini_api_key FROM bot_api_keys WHERE app_id = ?')
      .get(appId) as { gemini_api_key: string | null } | undefined

    if (apiKeys?.gemini_api_key) {
      geminiApiKey = apiKeys.gemini_api_key
    }
  }

  const transcription = await transcribeAudio({
    audio: audioBuffer,
    prompt: transcriptionPrompt,
    geminiApiKey,
  })

  voiceLogger.log(
    `Transcription successful: "${transcription.slice(0, 50)}${transcription.length > 50 ? '...' : ''}"`,
  )

  // Update thread name with transcribed content only for new threads
  if (isNewThread) {
    const threadName = transcription.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (threadName) {
      try {
        await Promise.race([
          thread.setName(threadName),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ])
        discordLogger.log(`Updated thread name to: "${threadName}"`)
      } catch (e) {
        discordLogger.log(`Could not update thread name:`, e)
      }
    }
  }

  await sendThreadMessage(
    thread,
    `📝 **Transcribed message:** ${escapeDiscordFormatting(transcription)}`,
  )
  return transcription
}

function getImageAttachments(message: Message): FilePartInput[] {
  const imageAttachments = Array.from(message.attachments.values()).filter(
    (attachment) => attachment.contentType?.startsWith('image/'),
  )

  return imageAttachments.map((attachment) => ({
    type: 'file' as const,
    mime: attachment.contentType || 'image/png',
    filename: attachment.name,
    url: attachment.url,
  }))
}

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
      lines.push({ text: '```' + lang + '\n', inCodeBlock: false, lang, isOpeningFence: true, isClosingFence: false })
      const codeLines = token.text.split('\n')
      for (const codeLine of codeLines) {
        lines.push({ text: codeLine + '\n', inCodeBlock: true, lang, isOpeningFence: false, isClosingFence: false })
      }
      lines.push({ text: '```\n', inCodeBlock: false, lang: '', isOpeningFence: false, isClosingFence: true })
    } else {
      const rawLines = token.raw.split('\n')
      for (let i = 0; i < rawLines.length; i++) {
        const isLast = i === rawLines.length - 1
        const text = isLast ? rawLines[i]! : rawLines[i]! + '\n'
        if (text) {
          lines.push({ text, inCodeBlock: false, lang: '', isOpeningFence: false, isClosingFence: false })
        }
      }
    }
  }

  const chunks: string[] = []
  let currentChunk = ''
  let currentLang: string | null = null

  for (const line of lines) {
    const wouldExceed = currentChunk.length + line.text.length > maxLength

    if (wouldExceed && currentChunk) {
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

/**
 * Escape Discord formatting characters to prevent breaking code blocks and inline code
 */
function escapeDiscordFormatting(text: string): string {
  return text
    .replace(/```/g, '\\`\\`\\`') // Triple backticks
    .replace(/````/g, '\\`\\`\\`\\`') // Quadruple backticks
}

function escapeInlineCode(text: string): string {
  return text
    .replace(/``/g, '\\`\\`') // Double backticks
    .replace(/(?<!\\)`(?!`)/g, '\\`') // Single backticks (not already escaped or part of double/triple)
    .replace(/\|\|/g, '\\|\\|') // Double pipes (spoiler syntax)
}

function resolveTextChannel(
  channel: TextChannel | ThreadChannel | null | undefined,
): TextChannel | null {
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
    const parent = channel.parent
    if (parent?.type === ChannelType.GuildText) {
      return parent as TextChannel
    }
  }

  return null
}

function getKimakiMetadata(textChannel: TextChannel | null): {
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

export async function initializeOpencodeForDirectory(directory: string) {
  // console.log(`[OPENCODE] Initializing for directory: ${directory}`)

  // Check if we already have a server for this directory
  const existing = opencodeServers.get(directory)
  if (existing && !existing.process.killed) {
    opencodeLogger.log(
      `Reusing existing server on port ${existing.port} for directory: ${directory}`,
    )
    return () => {
      const entry = opencodeServers.get(directory)
      if (!entry?.client) {
        throw new Error(
          `OpenCode server for directory "${directory}" is in an error state (no client available)`,
        )
      }
      return entry.client
    }
  }

  const port = await getOpenPort()
  // console.log(
  //   `[OPENCODE] Starting new server on port ${port} for directory: ${directory}`,
  // )

  const opencodeCommand = process.env.OPENCODE_PATH || 'opencode'

  const serverProcess = spawn(
    opencodeCommand,
    ['serve', '--port', port.toString()],
    {
      stdio: 'pipe',
      detached: false,
      cwd: directory,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          lsp: {
            typescript: { disabled: true },
            eslint: { disabled: true },
            gopls: { disabled: true },
            'ruby-lsp': { disabled: true },
            pyright: { disabled: true },
            'elixir-ls': { disabled: true },
            zls: { disabled: true },
            csharp: { disabled: true },
            vue: { disabled: true },
            rust: { disabled: true },
            clangd: { disabled: true },
            svelte: { disabled: true },
          },
          formatter: {
            prettier: { disabled: true },
            biome: { disabled: true },
            gofmt: { disabled: true },
            mix: { disabled: true },
            zig: { disabled: true },
            'clang-format': { disabled: true },
            ktlint: { disabled: true },
            ruff: { disabled: true },
            rubocop: { disabled: true },
            standardrb: { disabled: true },
            htmlbeautifier: { disabled: true },
          },
          permission: {
            edit: 'allow',
            bash: 'allow',
            webfetch: 'allow',
          },
        } satisfies Config),
        OPENCODE_PORT: port.toString(),
      },
    },
  )

  serverProcess.stdout?.on('data', (data) => {
    opencodeLogger.log(`opencode ${directory}: ${data.toString().trim()}`)
  })

  serverProcess.stderr?.on('data', (data) => {
    opencodeLogger.error(`opencode ${directory}: ${data.toString().trim()}`)
  })

  serverProcess.on('error', (error) => {
    opencodeLogger.error(`Failed to start server on port :`, port, error)
  })

  serverProcess.on('exit', (code) => {
    opencodeLogger.log(
      `Opencode server on ${directory} exited with code:`,
      code,
    )
    opencodeServers.delete(directory)
    if (code !== 0) {
      const retryCount = serverRetryCount.get(directory) || 0
      if (retryCount < 5) {
        serverRetryCount.set(directory, retryCount + 1)
        opencodeLogger.log(
          `Restarting server for directory: ${directory} (attempt ${retryCount + 1}/5)`,
        )
        initializeOpencodeForDirectory(directory).catch((e) => {
          opencodeLogger.error(`Failed to restart opencode server:`, e)
        })
      } else {
        opencodeLogger.error(
          `Server for ${directory} crashed too many times (5), not restarting`,
        )
      }
    } else {
      // Reset retry count on clean exit
      serverRetryCount.delete(directory)
    }
  })

  await waitForServer(port)

  const client = createOpencodeClient({
    baseUrl: `http://localhost:${port}`,
    fetch: (request: Request) =>
      fetch(request, {
        // @ts-ignore
        timeout: false,
      }),
  })

  opencodeServers.set(directory, {
    process: serverProcess,
    client,
    port,
  })

  return () => {
    const entry = opencodeServers.get(directory)
    if (!entry?.client) {
      throw new Error(
        `OpenCode server for directory "${directory}" is in an error state (no client available)`,
      )
    }
    return entry.client
  }
}

function getToolSummaryText(part: Part): string {
  if (part.type !== 'tool') return ''
  if (part.state.status !== 'completed' && part.state.status !== 'error') return ''

  if (part.tool === 'bash') {
    const output = part.state.status === 'completed' ? part.state.output : part.state.error
    const lines = (output || '').split('\n').filter((l: string) => l.trim())
    return `(${lines.length} line${lines.length === 1 ? '' : 's'})`
  }

  if (part.tool === 'edit') {
    const newString = (part.state.input?.newString as string) || ''
    const oldString = (part.state.input?.oldString as string) || ''
    const added = newString.split('\n').length
    const removed = oldString.split('\n').length
    return `(+${added}-${removed})`
  }

  if (part.tool === 'write') {
    const content = (part.state.input?.content as string) || ''
    const lines = content.split('\n').length
    return `(${lines} line${lines === 1 ? '' : 's'})`
  }

  if (part.tool === 'webfetch') {
    const url = (part.state.input?.url as string) || ''
    const urlWithoutProtocol = url.replace(/^https?:\/\//, '')
    return urlWithoutProtocol ? `(${urlWithoutProtocol})` : ''
  }

  if (
    part.tool === 'read' ||
    part.tool === 'list' ||
    part.tool === 'glob' ||
    part.tool === 'grep' ||
    part.tool === 'task' ||
    part.tool === 'todoread' ||
    part.tool === 'todowrite'
  ) {
    return ''
  }

  if (!part.state.input) return ''

  const inputFields = Object.entries(part.state.input)
    .map(([key, value]) => {
      if (value === null || value === undefined) return null
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
      const truncatedValue = stringValue.length > 100 ? stringValue.slice(0, 100) + '…' : stringValue
      return `${key}: ${truncatedValue}`
    })
    .filter(Boolean)

  if (inputFields.length === 0) return ''

  return `(${inputFields.join(', ')})`
}

function getToolOutputToDisplay(part: Part): string {
  if (part.type !== 'tool') return ''
  if (part.state.status !== 'completed' && part.state.status !== 'error') return ''

  if (part.state.status === 'error') {
    return part.state.error || 'Unknown error'
  }

  return ''
}

function formatTodoList(part: Part): string {
  if (part.type !== 'tool' || part.tool !== 'todowrite') return ''
  const todos =
    (part.state.input?.todos as {
      content: string
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
    }[]) || []
  if (todos.length === 0) return ''
  return todos
    .map((todo, i) => {
      const num = `${i + 1}.`
      if (todo.status === 'in_progress') {
        return `${num} **${todo.content}**`
      }
      if (todo.status === 'completed' || todo.status === 'cancelled') {
        return `${num} ~~${todo.content}~~`
      }
      return `${num} ${todo.content}`
    })
    .join('\n')
}

function formatPart(part: Part): string {
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

    if (part.state.status !== 'completed' && part.state.status !== 'error') {
      return ''
    }

    const summaryText = getToolSummaryText(part)
    const outputToDisplay = getToolOutputToDisplay(part)

    let toolTitle = ''
    if (part.state.status === 'error') {
      toolTitle = 'error'
    } else if (part.tool === 'bash') {
      const command = (part.state.input?.command as string) || ''
      const isSingleLine = !command.includes('\n')
      const hasBackticks = command.includes('`')
      if (isSingleLine && command.length <= 120 && !hasBackticks) {
        toolTitle = `\`${command}\``
      } else {
        toolTitle = part.state.title ? `*${part.state.title}*` : ''
      }
    } else if (part.state.title) {
      toolTitle = `*${part.state.title}*`
    }

    const icon = part.state.status === 'completed' ? '◼︎' : part.state.status === 'error' ? '⨯' : ''
    const title = `${icon} ${part.tool} ${toolTitle} ${summaryText}`

    if (outputToDisplay) {
      return title + '\n\n' + outputToDisplay
    }
    return title
  }

  discordLogger.warn('Unknown part type:', part)
  return ''
}

export async function createDiscordClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.ThreadMember,
    ],
  })
}

async function handleOpencodeSession({
  prompt,
  thread,
  projectDirectory,
  originalMessage,
  images = [],
  parsedCommand,
}: {
  prompt: string
  thread: ThreadChannel
  projectDirectory?: string
  originalMessage?: Message
  images?: FilePartInput[]
  parsedCommand?: ParsedCommand
}): Promise<{ sessionID: string; result: any; port?: number } | undefined> {
  voiceLogger.log(
    `[OPENCODE SESSION] Starting for thread ${thread.id} with prompt: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
  )

  // Track session start time
  const sessionStartTime = Date.now()

  // Add processing reaction to original message
  if (originalMessage) {
    try {
      await originalMessage.react('⏳')
      discordLogger.log(`Added processing reaction to message`)
    } catch (e) {
      discordLogger.log(`Could not add processing reaction:`, e)
    }
  }

  // Use default directory if not specified
  const directory = projectDirectory || process.cwd()
  sessionLogger.log(`Using directory: ${directory}`)

  // Note: We'll cancel the existing request after we have the session ID

  const getClient = await initializeOpencodeForDirectory(directory)

  // Get the port for this directory
  const serverEntry = opencodeServers.get(directory)
  const port = serverEntry?.port

  // Get session ID from database
  const row = getDatabase()
    .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
    .get(thread.id) as { session_id: string } | undefined
  let sessionId = row?.session_id
  let session

  if (sessionId) {
    sessionLogger.log(`Attempting to reuse existing session ${sessionId}`)
    try {
      const sessionResponse = await getClient().session.get({
        path: { id: sessionId },
      })
      session = sessionResponse.data
      sessionLogger.log(`Successfully reused session ${sessionId}`)
    } catch (error) {
      voiceLogger.log(
        `[SESSION] Session ${sessionId} not found, will create new one`,
      )
    }
  }

  if (!session) {
    voiceLogger.log(
      `[SESSION] Creating new session with title: "${prompt.slice(0, 80)}"`,
    )
    const sessionResponse = await getClient().session.create({
      body: { title: prompt.slice(0, 80) },
    })
    session = sessionResponse.data
    sessionLogger.log(`Created new session ${session?.id}`)
  }

  if (!session) {
    throw new Error('Failed to create or get session')
  }

  // Store session ID in database
  getDatabase()
    .prepare(
      'INSERT OR REPLACE INTO thread_sessions (thread_id, session_id) VALUES (?, ?)',
    )
    .run(thread.id, session.id)
  dbLogger.log(`Stored session ${session.id} for thread ${thread.id}`)

  // Cancel any existing request for this session
  const existingController = abortControllers.get(session.id)
  if (existingController) {
    voiceLogger.log(
      `[ABORT] Cancelling existing request for session: ${session.id}`,
    )
    existingController.abort(new Error('New request started'))
  }

  if (abortControllers.has(session.id)) {
    abortControllers.get(session.id)?.abort(new Error('new reply'))
  }
  const abortController = new AbortController()
  // Store this controller for this session
  abortControllers.set(session.id, abortController)

  const eventsResult = await getClient().event.subscribe({
    signal: abortController.signal,
  })
  const events = eventsResult.stream
  sessionLogger.log(`Subscribed to OpenCode events`)

  // Load existing part-message mappings from database
  const partIdToMessage = new Map<string, Message>()
  const existingParts = getDatabase()
    .prepare(
      'SELECT part_id, message_id FROM part_messages WHERE thread_id = ?',
    )
    .all(thread.id) as { part_id: string; message_id: string }[]

  // Pre-populate map with existing messages
  for (const row of existingParts) {
    try {
      const message = await thread.messages.fetch(row.message_id)
      if (message) {
        partIdToMessage.set(row.part_id, message)
      }
    } catch (error) {
      voiceLogger.log(
        `Could not fetch message ${row.message_id} for part ${row.part_id}`,
      )
    }
  }

  let currentParts: Part[] = []
  let stopTyping: (() => void) | null = null
  let usedModel: string | undefined
  let usedProviderID: string | undefined
  let inputTokens = 0

  const sendPartMessage = async (part: Part) => {
    const content = formatPart(part) + '\n\n'
    if (!content.trim() || content.length === 0) {
      discordLogger.log(`SKIP: Part ${part.id} has no content`)
      return
    }

    // Skip if already sent
    if (partIdToMessage.has(part.id)) {
      return
    }

    try {
      const firstMessage = await sendThreadMessage(thread, content)
      partIdToMessage.set(part.id, firstMessage)

      // Store part-message mapping in database
      getDatabase()
        .prepare(
          'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)',
        )
        .run(part.id, firstMessage.id, thread.id)
    } catch (error) {
      discordLogger.error(`ERROR: Failed to send part ${part.id}:`, error)
    }
  }

  const eventHandler = async () => {
    // Local typing function for this session
    // Outer-scoped interval for typing notifications. Only one at a time.
    let typingInterval: NodeJS.Timeout | null = null

    function startTyping(thread: ThreadChannel): () => void {
      if (abortController.signal.aborted) {
        discordLogger.log(`Not starting typing, already aborted`)
        return () => {}
      }
      // Clear any previous typing interval
      if (typingInterval) {
        clearInterval(typingInterval)
        typingInterval = null
      }

      // Send initial typing
      thread.sendTyping().catch((e) => {
        discordLogger.log(`Failed to send initial typing: ${e}`)
      })

      // Set up interval to send typing every 8 seconds
      typingInterval = setInterval(() => {
        thread.sendTyping().catch((e) => {
          discordLogger.log(`Failed to send periodic typing: ${e}`)
        })
      }, 8000)

      // Only add listener if not already aborted
      if (!abortController.signal.aborted) {
        abortController.signal.addEventListener(
          'abort',
          () => {
            if (typingInterval) {
              clearInterval(typingInterval)
              typingInterval = null
            }
          },
          {
            once: true,
          },
        )
      }

      // Return stop function
      return () => {
        if (typingInterval) {
          clearInterval(typingInterval)
          typingInterval = null
        }
      }
    }

    try {
      let assistantMessageId: string | undefined

      for await (const event of events) {
        if (event.type === 'message.updated') {
          const msg = event.properties.info

          if (msg.sessionID !== session.id) {
            continue
          }

          // Track assistant message ID
          if (msg.role === 'assistant') {
            assistantMessageId = msg.id
            usedModel = msg.modelID
            usedProviderID = msg.providerID
            if (msg.tokens.input > 0) {
              inputTokens = msg.tokens.input
            }
          }
        } else if (event.type === 'message.part.updated') {
          const part = event.properties.part

          if (part.sessionID !== session.id) {
            continue
          }

          // Only process parts from assistant messages
          if (part.messageID !== assistantMessageId) {
            continue
          }

          const existingIndex = currentParts.findIndex(
            (p: Part) => p.id === part.id,
          )
          if (existingIndex >= 0) {
            currentParts[existingIndex] = part
          } else {
            currentParts.push(part)
          }



          // Start typing on step-start
          if (part.type === 'step-start') {
            stopTyping = startTyping(thread)
          }

          // Check if this is a step-finish part
          if (part.type === 'step-finish') {
            // Track tokens from step-finish part
            if (part.tokens?.input && part.tokens.input > 0) {
              inputTokens = part.tokens.input
              voiceLogger.log(`[STEP-FINISH] Captured tokens: ${inputTokens}`)
            }
            // Send all parts accumulated so far to Discord
            for (const p of currentParts) {
              // Skip step-start and step-finish parts as they have no visual content
              if (p.type !== 'step-start' && p.type !== 'step-finish') {
                await sendPartMessage(p)
              }
            }
            // start typing in a moment, so that if the session finished, because step-finish is at the end of the message, we do not show typing status
            setTimeout(() => {
              if (abortController.signal.aborted) return
              stopTyping = startTyping(thread)
            }, 300)
          }
        } else if (event.type === 'session.error') {
          sessionLogger.error(`ERROR:`, event.properties)
          if (event.properties.sessionID === session.id) {
            const errorData = event.properties.error
            const errorMessage = errorData?.data?.message || 'Unknown error'
            sessionLogger.error(`Sending error to thread: ${errorMessage}`)
            await sendThreadMessage(
              thread,
              `✗ opencode session error: ${errorMessage}`,
            )

            // Update reaction to error
            if (originalMessage) {
              try {
                await originalMessage.reactions.removeAll()
                await originalMessage.react('❌')
                voiceLogger.log(
                  `[REACTION] Added error reaction due to session error`,
                )
              } catch (e) {
                discordLogger.log(`Could not update reaction:`, e)
              }
            }
          } else {
            voiceLogger.log(
              `[SESSION ERROR IGNORED] Error for different session (expected: ${session.id}, got: ${event.properties.sessionID})`,
            )
          }
          break
        } else if (event.type === 'permission.updated') {
          const permission = event.properties
          if (permission.sessionID !== session.id) {
            voiceLogger.log(
              `[PERMISSION IGNORED] Permission for different session (expected: ${session.id}, got: ${permission.sessionID})`,
            )
            continue
          }

          sessionLogger.log(
            `Permission requested: type=${permission.type}, title=${permission.title}`,
          )

          const patternStr = Array.isArray(permission.pattern)
            ? permission.pattern.join(', ')
            : permission.pattern || ''

          const permissionMessage = await sendThreadMessage(
            thread,
            `⚠️ **Permission Required**\n\n` +
              `**Type:** \`${permission.type}\`\n` +
              `**Action:** ${permission.title}\n` +
              (patternStr ? `**Pattern:** \`${patternStr}\`\n` : '') +
              `\nUse \`/accept\` or \`/reject\` to respond.`,
          )

          pendingPermissions.set(thread.id, {
            permission,
            messageId: permissionMessage.id,
            directory,
          })
        } else if (event.type === 'permission.replied') {
          const { permissionID, response, sessionID } = event.properties
          if (sessionID !== session.id) {
            continue
          }

          sessionLogger.log(
            `Permission ${permissionID} replied with: ${response}`,
          )

          const pending = pendingPermissions.get(thread.id)
          if (pending && pending.permission.id === permissionID) {
            pendingPermissions.delete(thread.id)
          }
        }
      }
    } catch (e) {
      if (isAbortError(e, abortController.signal)) {
        sessionLogger.log(
          'AbortController aborted event handling (normal exit)',
        )
        return
      }
      sessionLogger.error(`Unexpected error in event handling code`, e)
      throw e
    } finally {
      // Send any remaining parts that weren't sent
      for (const part of currentParts) {
        if (!partIdToMessage.has(part.id)) {
          try {
            await sendPartMessage(part)
          } catch (error) {
            sessionLogger.error(`Failed to send part ${part.id}:`, error)
          }
        }
      }

      // Stop typing when session ends
      if (stopTyping) {
        stopTyping()
        stopTyping = null
      }

      // Only send duration message if request was not aborted or was aborted with 'finished' reason
      if (
        !abortController.signal.aborted ||
        abortController.signal.reason === 'finished'
      ) {
        const sessionDuration = prettyMilliseconds(
          Date.now() - sessionStartTime,
        )
        const attachCommand = port ? ` ⋅ ${session.id}` : ''
        const modelInfo = usedModel ? ` ⋅ ${usedModel}` : ''
        let contextInfo = ''
        if (inputTokens > 0 && usedProviderID && usedModel) {
          try {
            const providersResponse = await getClient().provider.list({ query: { directory } })
            const provider = providersResponse.data?.all?.find((p) => p.id === usedProviderID)
            const model = provider?.models?.[usedModel]
            if (model?.limit?.context) {
              const percentage = Math.round((inputTokens / model.limit.context) * 100)
              contextInfo = ` ⋅ ${percentage}%`
            }
          } catch (e) {
            sessionLogger.error('Failed to fetch provider info for context percentage:', e)
          }
        }
        await sendThreadMessage(thread, `_Completed in ${sessionDuration}${contextInfo}_${attachCommand}${modelInfo}`)
        sessionLogger.log(`DURATION: Session completed in ${sessionDuration}, port ${port}, model ${usedModel}, tokens ${inputTokens}`)
      } else {
        sessionLogger.log(
          `Session was aborted (reason: ${abortController.signal.reason}), skipping duration message`,
        )
      }
    }
  }

  try {
    // Start the event handler
    const eventHandlerPromise = eventHandler()

    let response: { data?: unknown }
    if (parsedCommand?.isCommand) {
      sessionLogger.log(
        `[COMMAND] Sending command /${parsedCommand.command} to session ${session.id} with args: "${parsedCommand.arguments.slice(0, 100)}${parsedCommand.arguments.length > 100 ? '...' : ''}"`,
      )
      response = await getClient().session.command({
        path: { id: session.id },
        body: {
          command: parsedCommand.command,
          arguments: parsedCommand.arguments,
        },
        signal: abortController.signal,
      })
    } else {
      voiceLogger.log(
        `[PROMPT] Sending prompt to session ${session.id}: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`,
      )
      if (images.length > 0) {
        sessionLogger.log(`[PROMPT] Sending ${images.length} image(s):`, images.map((img) => ({ mime: img.mime, filename: img.filename, url: img.url.slice(0, 100) })))
      }

      const parts = [{ type: 'text' as const, text: prompt }, ...images]
      sessionLogger.log(`[PROMPT] Parts to send:`, parts.length)

      response = await getClient().session.prompt({
        path: { id: session.id },
        body: {
          parts,
          system: getOpencodeSystemMessage({ sessionId: session.id }),
        },
        signal: abortController.signal,
      })
    }
    abortController.abort('finished')

    sessionLogger.log(`Successfully sent prompt, got response`)

    // Update reaction to success
    if (originalMessage) {
      try {
        await originalMessage.reactions.removeAll()
        await originalMessage.react('✅')
        discordLogger.log(`Added success reaction to message`)
      } catch (e) {
        discordLogger.log(`Could not update reaction:`, e)
      }
    }

    return { sessionID: session.id, result: response.data, port }
  } catch (error) {
    sessionLogger.error(`ERROR: Failed to send prompt:`, error)

    if (!isAbortError(error, abortController.signal)) {
      abortController.abort('error')

      if (originalMessage) {
        try {
          await originalMessage.reactions.removeAll()
          await originalMessage.react('❌')
          discordLogger.log(`Added error reaction to message`)
        } catch (e) {
          discordLogger.log(`Could not update reaction:`, e)
        }
      }
      const errorName =
        error &&
        typeof error === 'object' &&
        'constructor' in error &&
        error.constructor &&
        typeof error.constructor.name === 'string'
          ? error.constructor.name
          : typeof error
      const errorMsg =
        error instanceof Error ? error.stack || error.message : String(error)
      await sendThreadMessage(
        thread,
        `✗ Unexpected bot Error: [${errorName}]\n${errorMsg}`,
      )
    }
  }
}

export type ChannelWithTags = {
  id: string
  name: string
  description: string | null
  kimakiDirectory?: string
  kimakiApp?: string
}

export async function getChannelsWithDescriptions(
  guild: Guild,
): Promise<ChannelWithTags[]> {
  const channels: ChannelWithTags[] = []

  guild.channels.cache
    .filter((channel) => channel.isTextBased())
    .forEach((channel) => {
      const textChannel = channel as TextChannel
      const description = textChannel.topic || null

      let kimakiDirectory: string | undefined
      let kimakiApp: string | undefined

      if (description) {
        const extracted = extractTagsArrays({
          xml: description,
          tags: ['kimaki.directory', 'kimaki.app'],
        })

        kimakiDirectory = extracted['kimaki.directory']?.[0]?.trim()
        kimakiApp = extracted['kimaki.app']?.[0]?.trim()
      }

      channels.push({
        id: textChannel.id,
        name: textChannel.name,
        description,
        kimakiDirectory,
        kimakiApp,
      })
    })

  return channels
}

export async function startDiscordBot({
  token,
  appId,
  discordClient,
}: StartOptions & { discordClient?: Client }) {
  if (!discordClient) {
    discordClient = await createDiscordClient()
  }

  // Get the app ID for this bot instance
  let currentAppId: string | undefined = appId

  discordClient.once(Events.ClientReady, async (c) => {
    discordLogger.log(`Discord bot logged in as ${c.user.tag}`)
    discordLogger.log(`Connected to ${c.guilds.cache.size} guild(s)`)
    discordLogger.log(`Bot user ID: ${c.user.id}`)

    // If appId wasn't provided, fetch it from the application
    if (!currentAppId) {
      await c.application?.fetch()
      currentAppId = c.application?.id

      if (!currentAppId) {
        discordLogger.error('Could not get application ID')
        throw new Error('Failed to get bot application ID')
      }
      discordLogger.log(`Bot Application ID (fetched): ${currentAppId}`)
    } else {
      discordLogger.log(`Bot Application ID (provided): ${currentAppId}`)
    }

    // List all guilds and channels that belong to this bot
    for (const guild of c.guilds.cache.values()) {
      discordLogger.log(`${guild.name} (${guild.id})`)

      const channels = await getChannelsWithDescriptions(guild)
      // Only show channels that belong to this bot
      const kimakiChannels = channels.filter(
        (ch) =>
          ch.kimakiDirectory &&
          (!ch.kimakiApp || ch.kimakiApp === currentAppId),
      )

      if (kimakiChannels.length > 0) {
        discordLogger.log(
          `  Found ${kimakiChannels.length} channel(s) for this bot:`,
        )
        for (const channel of kimakiChannels) {
          discordLogger.log(`  - #${channel.name}: ${channel.kimakiDirectory}`)
        }
      } else {
        discordLogger.log(`  No channels for this bot`)
      }
    }

    voiceLogger.log(
      `[READY] Bot is ready and will only respond to channels with app ID: ${currentAppId}`,
    )
  })

  discordClient.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author?.bot) {
        return
      }
      if (message.partial) {
        discordLogger.log(`Fetching partial message ${message.id}`)
        try {
          await message.fetch()
        } catch (error) {
          discordLogger.log(
            `Failed to fetch partial message ${message.id}:`,
            error,
          )
          return
        }
      }

      // Check if user is authoritative (server owner or has admin permissions)
      if (message.guild && message.member) {
        const isOwner = message.member.id === message.guild.ownerId
        const isAdmin = message.member.permissions.has(
          PermissionsBitField.Flags.Administrator,
        )

        if (!isOwner && !isAdmin) {
          return
        }
      }

      const channel = message.channel
      const isThread = [
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ].includes(channel.type)

      // For existing threads, check if session exists
      if (isThread) {
        const thread = channel as ThreadChannel
        discordLogger.log(`Message in thread ${thread.name} (${thread.id})`)

        const row = getDatabase()
          .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
          .get(thread.id) as { session_id: string } | undefined

        if (!row) {
          discordLogger.log(`No session found for thread ${thread.id}`)
          return
        }

        voiceLogger.log(
          `[SESSION] Found session ${row.session_id} for thread ${thread.id}`,
        )

        // Get project directory and app ID from parent channel
        const parent = thread.parent as TextChannel | null
        let projectDirectory: string | undefined
        let channelAppId: string | undefined

        if (parent?.topic) {
          const extracted = extractTagsArrays({
            xml: parent.topic,
            tags: ['kimaki.directory', 'kimaki.app'],
          })

          projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
          channelAppId = extracted['kimaki.app']?.[0]?.trim()
        }

        // Check if this channel belongs to current bot instance
        if (channelAppId && channelAppId !== currentAppId) {
          voiceLogger.log(
            `[IGNORED] Thread belongs to different bot app (expected: ${currentAppId}, got: ${channelAppId})`,
          )
          return
        }

        if (projectDirectory && !fs.existsSync(projectDirectory)) {
          discordLogger.error(`Directory does not exist: ${projectDirectory}`)
          await sendThreadMessage(
            thread,
            `✗ Directory does not exist: ${JSON.stringify(projectDirectory)}`,
          )
          return
        }

        // Handle voice message if present
        let messageContent = message.content || ''

        const transcription = await processVoiceAttachment({
          message,
          thread,
          projectDirectory,
          appId: currentAppId,
        })
        if (transcription) {
          messageContent = transcription
        }

        const images = getImageAttachments(message)
        const parsedCommand = parseSlashCommand(messageContent)
        await handleOpencodeSession({
          prompt: messageContent,
          thread,
          projectDirectory,
          originalMessage: message,
          images,
          parsedCommand,
        })
        return
      }

      // For text channels, start new sessions with kimaki.directory tag
      if (channel.type === ChannelType.GuildText) {
        const textChannel = channel as TextChannel
        voiceLogger.log(
          `[GUILD_TEXT] Message in text channel #${textChannel.name} (${textChannel.id})`,
        )

        if (!textChannel.topic) {
          voiceLogger.log(
            `[IGNORED] Channel #${textChannel.name} has no description`,
          )
          return
        }

        const extracted = extractTagsArrays({
          xml: textChannel.topic,
          tags: ['kimaki.directory', 'kimaki.app'],
        })

        const projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
        const channelAppId = extracted['kimaki.app']?.[0]?.trim()

        if (!projectDirectory) {
          voiceLogger.log(
            `[IGNORED] Channel #${textChannel.name} has no kimaki.directory tag`,
          )
          return
        }

        // Check if this channel belongs to current bot instance
        if (channelAppId && channelAppId !== currentAppId) {
          voiceLogger.log(
            `[IGNORED] Channel belongs to different bot app (expected: ${currentAppId}, got: ${channelAppId})`,
          )
          return
        }

        discordLogger.log(
          `DIRECTORY: Found kimaki.directory: ${projectDirectory}`,
        )
        if (channelAppId) {
          discordLogger.log(`APP: Channel app ID: ${channelAppId}`)
        }

        if (!fs.existsSync(projectDirectory)) {
          discordLogger.error(`Directory does not exist: ${projectDirectory}`)
          await message.reply(
            `✗ Directory does not exist: ${JSON.stringify(projectDirectory)}`,
          )
          return
        }

        // Determine if this is a voice message
        const hasVoice = message.attachments.some((a) =>
          a.contentType?.startsWith('audio/'),
        )

        // Create thread
        const threadName = hasVoice
          ? 'Voice Message'
          : message.content?.replace(/\s+/g, ' ').trim() || 'Claude Thread'

        const thread = await message.startThread({
          name: threadName.slice(0, 80),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: 'Start Claude session',
        })

        discordLogger.log(`Created thread "${thread.name}" (${thread.id})`)

        // Handle voice message if present
        let messageContent = message.content || ''

        const transcription = await processVoiceAttachment({
          message,
          thread,
          projectDirectory,
          isNewThread: true,
          appId: currentAppId,
        })
        if (transcription) {
          messageContent = transcription
        }

        const images = getImageAttachments(message)
        const parsedCommand = parseSlashCommand(messageContent)
        await handleOpencodeSession({
          prompt: messageContent,
          thread,
          projectDirectory,
          originalMessage: message,
          images,
          parsedCommand,
        })
      } else {
        discordLogger.log(`Channel type ${channel.type} is not supported`)
      }
    } catch (error) {
      voiceLogger.error('Discord handler error:', error)
      try {
        const errMsg = error instanceof Error ? error.message : String(error)
        await message.reply(`Error: ${errMsg}`)
      } catch {
        voiceLogger.error('Discord handler error (fallback):', error)
      }
    }
  })

  // Handle slash command interactions
  discordClient.on(
    Events.InteractionCreate,
    async (interaction: Interaction) => {
      try {
        // Handle autocomplete
        if (interaction.isAutocomplete()) {
          if (interaction.commandName === 'resume') {
            const focusedValue = interaction.options.getFocused()

            // Get the channel's project directory from its topic
            let projectDirectory: string | undefined
            if (
              interaction.channel &&
              interaction.channel.type === ChannelType.GuildText
            ) {
              const textChannel = resolveTextChannel(
                interaction.channel as TextChannel | ThreadChannel | null,
              )
              if (textChannel) {
                const { projectDirectory: directory, channelAppId } =
                  getKimakiMetadata(textChannel)
                if (channelAppId && channelAppId !== currentAppId) {
                  await interaction.respond([])
                  return
                }
                projectDirectory = directory
              }
            }

            if (!projectDirectory) {
              await interaction.respond([])
              return
            }

            try {
              // Get OpenCode client for this directory
              const getClient =
                await initializeOpencodeForDirectory(projectDirectory)

              // List sessions
              const sessionsResponse = await getClient().session.list()
              if (!sessionsResponse.data) {
                await interaction.respond([])
                return
              }

              // Filter and map sessions to choices
              const sessions = sessionsResponse.data
                .filter((session) =>
                  session.title
                    .toLowerCase()
                    .includes(focusedValue.toLowerCase()),
                )
                .slice(0, 25) // Discord limit
                .map((session) => {
                  const dateStr = new Date(
                    session.time.updated,
                  ).toLocaleString()
                  const suffix = ` (${dateStr})`
                  // Discord limit is 100 chars. Reserve space for suffix.
                  const maxTitleLength = 100 - suffix.length

                  let title = session.title
                  if (title.length > maxTitleLength) {
                    title = title.slice(0, Math.max(0, maxTitleLength - 1)) + '…'
                  }

                  return {
                    name: `${title}${suffix}`,
                    value: session.id,
                  }
                })

              await interaction.respond(sessions)
            } catch (error) {
              voiceLogger.error(
                '[AUTOCOMPLETE] Error fetching sessions:',
                error,
              )
              await interaction.respond([])
            }
          } else if (interaction.commandName === 'session') {
            const focusedOption = interaction.options.getFocused(true)

            if (focusedOption.name === 'files') {
              const focusedValue = focusedOption.value

              // Split by comma to handle multiple files
              const parts = focusedValue.split(',')
              const previousFiles = parts
                .slice(0, -1)
                .map((f) => f.trim())
                .filter((f) => f)
              const currentQuery = (parts[parts.length - 1] || '').trim()

              // Get the channel's project directory from its topic
              let projectDirectory: string | undefined
              if (
                interaction.channel &&
                interaction.channel.type === ChannelType.GuildText
              ) {
                const textChannel = resolveTextChannel(
                  interaction.channel as TextChannel | ThreadChannel | null,
                )
                if (textChannel) {
                  const { projectDirectory: directory, channelAppId } =
                    getKimakiMetadata(textChannel)
                  if (channelAppId && channelAppId !== currentAppId) {
                    await interaction.respond([])
                    return
                  }
                  projectDirectory = directory
                }
              }

              if (!projectDirectory) {
                await interaction.respond([])
                return
              }

              try {
                // Get OpenCode client for this directory
                const getClient =
                  await initializeOpencodeForDirectory(projectDirectory)

                // Use find.files to search for files based on current query
                const response = await getClient().find.files({
                  query: {
                    query: currentQuery || '',
                  },
                })

                // Get file paths from the response
                const files = response.data || []

                // Build the prefix with previous files
                const prefix =
                  previousFiles.length > 0
                    ? previousFiles.join(', ') + ', '
                    : ''

                // Map to Discord autocomplete format
                const choices = files
                  .map((file: string) => {
                    const fullValue = prefix + file
                    // Get all basenames for display
                    const allFiles = [...previousFiles, file]
                    const allBasenames = allFiles.map(
                      (f) => f.split('/').pop() || f,
                    )
                    let displayName = allBasenames.join(', ')
                    // Truncate if too long
                    if (displayName.length > 100) {
                      displayName = '…' + displayName.slice(-97)
                    }
                    return {
                      name: displayName,
                      value: fullValue,
                    }
                  })
                  // Discord API limits choice value to 100 characters
                  .filter((choice) => choice.value.length <= 100)
                  .slice(0, 25) // Discord limit


                await interaction.respond(choices)
              } catch (error) {
                voiceLogger.error('[AUTOCOMPLETE] Error fetching files:', error)
                await interaction.respond([])
              }
            }
          } else if (interaction.commandName === 'add-project') {
            const focusedValue = interaction.options.getFocused()

            try {
              const currentDir = process.cwd()
              const getClient = await initializeOpencodeForDirectory(currentDir)

              const projectsResponse = await getClient().project.list({})
              if (!projectsResponse.data) {
                await interaction.respond([])
                return
              }

              const db = getDatabase()
              const existingDirs = db
                .prepare(
                  'SELECT DISTINCT directory FROM channel_directories WHERE channel_type = ?',
                )
                .all('text') as { directory: string }[]
              const existingDirSet = new Set(
                existingDirs.map((row) => row.directory),
              )

              const availableProjects = projectsResponse.data.filter(
                (project) => !existingDirSet.has(project.worktree),
              )

              const projects = availableProjects
                .filter((project) => {
                  const baseName = path.basename(project.worktree)
                  const searchText = `${baseName} ${project.worktree}`.toLowerCase()
                  return searchText.includes(focusedValue.toLowerCase())
                })
                .sort((a, b) => {
                  const aTime = a.time.initialized || a.time.created
                  const bTime = b.time.initialized || b.time.created
                  return bTime - aTime
                })
                .slice(0, 25)
                .map((project) => {
                  const name = `${path.basename(project.worktree)} (${project.worktree})`
                  return {
                    name: name.length > 100 ? name.slice(0, 99) + '…' : name,
                    value: project.id,
                  }
                })

              await interaction.respond(projects)
            } catch (error) {
              voiceLogger.error(
                '[AUTOCOMPLETE] Error fetching projects:',
                error,
              )
              await interaction.respond([])
            }
          }
        }

        // Handle slash commands
        if (interaction.isChatInputCommand()) {
          const command = interaction

          if (command.commandName === 'session') {
            await command.deferReply({ ephemeral: false })

            const prompt = command.options.getString('prompt', true)
            const filesString = command.options.getString('files') || ''
            const channel = command.channel

            if (!channel || channel.type !== ChannelType.GuildText) {
              await command.editReply(
                'This command can only be used in text channels',
              )
              return
            }

            const textChannel = channel as TextChannel

            // Get project directory from channel topic
            let projectDirectory: string | undefined
            let channelAppId: string | undefined

            if (textChannel.topic) {
              const extracted = extractTagsArrays({
                xml: textChannel.topic,
                tags: ['kimaki.directory', 'kimaki.app'],
              })

              projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
              channelAppId = extracted['kimaki.app']?.[0]?.trim()
            }

            // Check if this channel belongs to current bot instance
            if (channelAppId && channelAppId !== currentAppId) {
              await command.editReply(
                'This channel is not configured for this bot',
              )
              return
            }

            if (!projectDirectory) {
              await command.editReply(
                'This channel is not configured with a project directory',
              )
              return
            }

            if (!fs.existsSync(projectDirectory)) {
              await command.editReply(
                `Directory does not exist: ${projectDirectory}`,
              )
              return
            }

            try {
              // Initialize OpenCode client for the directory
              const getClient =
                await initializeOpencodeForDirectory(projectDirectory)

              // Process file mentions - split by comma only
              const files = filesString
                .split(',')
                .map((f) => f.trim())
                .filter((f) => f)

              // Build the full prompt with file mentions
              let fullPrompt = prompt
              if (files.length > 0) {
                fullPrompt = `${prompt}\n\n@${files.join(' @')}`
              }

              // Send a message first, then create thread from it
              const starterMessage = await textChannel.send({
                content: `🚀 **Starting OpenCode session**\n📝 ${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}${files.length > 0 ? `\n📎 Files: ${files.join(', ')}` : ''}`,
              })

              // Create thread from the message
              const thread = await starterMessage.startThread({
                name: prompt.slice(0, 100),
                autoArchiveDuration: 1440, // 24 hours
                reason: 'OpenCode session',
              })

              await command.editReply(
                `Created new session in ${thread.toString()}`,
              )

              // Start the OpenCode session
              const parsedCommand = parseSlashCommand(fullPrompt)
              await handleOpencodeSession({
                prompt: fullPrompt,
                thread,
                projectDirectory,
                parsedCommand,
              })
            } catch (error) {
              voiceLogger.error('[SESSION] Error:', error)
              await command.editReply(
                `Failed to create session: ${error instanceof Error ? error.message : 'Unknown error'}`,
              )
            }
          } else if (command.commandName === 'resume') {
            await command.deferReply({ ephemeral: false })

            const sessionId = command.options.getString('session', true)
            const channel = command.channel

            if (!channel || channel.type !== ChannelType.GuildText) {
              await command.editReply(
                'This command can only be used in text channels',
              )
              return
            }

            const textChannel = channel as TextChannel

            // Get project directory from channel topic
            let projectDirectory: string | undefined
            let channelAppId: string | undefined

            if (textChannel.topic) {
              const extracted = extractTagsArrays({
                xml: textChannel.topic,
                tags: ['kimaki.directory', 'kimaki.app'],
              })

              projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
              channelAppId = extracted['kimaki.app']?.[0]?.trim()
            }

            // Check if this channel belongs to current bot instance
            if (channelAppId && channelAppId !== currentAppId) {
              await command.editReply(
                'This channel is not configured for this bot',
              )
              return
            }

            if (!projectDirectory) {
              await command.editReply(
                'This channel is not configured with a project directory',
              )
              return
            }

            if (!fs.existsSync(projectDirectory)) {
              await command.editReply(
                `Directory does not exist: ${projectDirectory}`,
              )
              return
            }

            try {
              // Initialize OpenCode client for the directory
              const getClient =
                await initializeOpencodeForDirectory(projectDirectory)

              // Get session title
              const sessionResponse = await getClient().session.get({
                path: { id: sessionId },
              })

              if (!sessionResponse.data) {
                await command.editReply('Session not found')
                return
              }

              const sessionTitle = sessionResponse.data.title

              // Create thread for the resumed session
              const thread = await textChannel.threads.create({
                name: `Resume: ${sessionTitle}`.slice(0, 100),
                autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
                reason: `Resuming session ${sessionId}`,
              })

              // Store session ID in database
              getDatabase()
                .prepare(
                  'INSERT OR REPLACE INTO thread_sessions (thread_id, session_id) VALUES (?, ?)',
                )
                .run(thread.id, sessionId)

              voiceLogger.log(
                `[RESUME] Created thread ${thread.id} for session ${sessionId}`,
              )

              // Fetch all messages for the session
              const messagesResponse = await getClient().session.messages({
                path: { id: sessionId },
              })

              if (!messagesResponse.data) {
                throw new Error('Failed to fetch session messages')
              }

              const messages = messagesResponse.data

              await command.editReply(
                `Resumed session "${sessionTitle}" in ${thread.toString()}`,
              )

              // Send initial message to thread
              await sendThreadMessage(
                thread,
                `📂 **Resumed session:** ${sessionTitle}\n📅 **Created:** ${new Date(sessionResponse.data.time.created).toLocaleString()}\n\n*Loading ${messages.length} messages...*`,
              )

              // Collect all assistant parts first, then only render the last 30
              const allAssistantParts: { id: string; content: string }[] = []
              for (const message of messages) {
                if (message.info.role === 'assistant') {
                  for (const part of message.parts) {
                    const content = formatPart(part)
                    if (content.trim()) {
                      allAssistantParts.push({ id: part.id, content })
                    }
                  }
                }
              }

              const partsToRender = allAssistantParts.slice(-30)
              const skippedCount = allAssistantParts.length - partsToRender.length

              if (skippedCount > 0) {
                await sendThreadMessage(
                  thread,
                  `*Skipped ${skippedCount} older assistant parts...*`,
                )
              }

              if (partsToRender.length > 0) {
                const combinedContent = partsToRender
                  .map((p) => p.content)
                  .join('\n\n')

                const discordMessage = await sendThreadMessage(
                  thread,
                  combinedContent,
                )

                const stmt = getDatabase().prepare(
                  'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)',
                )

                const transaction = getDatabase().transaction(
                  (parts: { id: string }[]) => {
                    for (const part of parts) {
                      stmt.run(part.id, discordMessage.id, thread.id)
                    }
                  },
                )

                transaction(partsToRender)
              }

              const messageCount = messages.length

              await sendThreadMessage(
                thread,
                `✅ **Session resumed!** Loaded ${messageCount} messages.\n\nYou can now continue the conversation by sending messages in this thread.`,
              )
            } catch (error) {
              voiceLogger.error('[RESUME] Error:', error)
              await command.editReply(
                `Failed to resume session: ${error instanceof Error ? error.message : 'Unknown error'}`,
              )
            }
          } else if (command.commandName === 'add-project') {
            await command.deferReply({ ephemeral: false })

            const projectId = command.options.getString('project', true)
            const guild = command.guild

            if (!guild) {
              await command.editReply('This command can only be used in a guild')
              return
            }

            try {
              const currentDir = process.cwd()
              const getClient = await initializeOpencodeForDirectory(currentDir)

              const projectsResponse = await getClient().project.list({})
              if (!projectsResponse.data) {
                await command.editReply('Failed to fetch projects')
                return
              }

              const project = projectsResponse.data.find(
                (p) => p.id === projectId,
              )

              if (!project) {
                await command.editReply('Project not found')
                return
              }

              const directory = project.worktree

              if (!fs.existsSync(directory)) {
                await command.editReply(`Directory does not exist: ${directory}`)
                return
              }

              const db = getDatabase()
              const existingChannel = db
                .prepare(
                  'SELECT channel_id FROM channel_directories WHERE directory = ? AND channel_type = ?',
                )
                .get(directory, 'text') as { channel_id: string } | undefined

              if (existingChannel) {
                await command.editReply(
                  `A channel already exists for this directory: <#${existingChannel.channel_id}>`,
                )
                return
              }

              const { textChannelId, voiceChannelId, channelName } =
                await createProjectChannels({
                  guild,
                  projectDirectory: directory,
                  appId: currentAppId!,
                })

              await command.editReply(
                `✅ Created channels for project:\n📝 Text: <#${textChannelId}>\n🔊 Voice: <#${voiceChannelId}>\n📁 Directory: \`${directory}\``,
              )

              discordLogger.log(
                `Created channels for project ${channelName} at ${directory}`,
              )
            } catch (error) {
              voiceLogger.error('[ADD-PROJECT] Error:', error)
              await command.editReply(
                `Failed to create channels: ${error instanceof Error ? error.message : 'Unknown error'}`,
              )
            }
          } else if (
            command.commandName === 'accept' ||
            command.commandName === 'accept-always'
          ) {
            const scope = command.commandName === 'accept-always' ? 'always' : 'once'
            const channel = command.channel

            if (!channel) {
              await command.reply({
                content: 'This command can only be used in a channel',
                ephemeral: true,
              })
              return
            }

            const isThread = [
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
              ChannelType.AnnouncementThread,
            ].includes(channel.type)

            if (!isThread) {
              await command.reply({
                content: 'This command can only be used in a thread with an active session',
                ephemeral: true,
              })
              return
            }

            const pending = pendingPermissions.get(channel.id)
            if (!pending) {
              await command.reply({
                content: 'No pending permission request in this thread',
                ephemeral: true,
              })
              return
            }

            try {
              const getClient = await initializeOpencodeForDirectory(pending.directory)
              await getClient().postSessionIdPermissionsPermissionId({
                path: {
                  id: pending.permission.sessionID,
                  permissionID: pending.permission.id,
                },
                body: {
                  response: scope,
                },
              })

              pendingPermissions.delete(channel.id)
              const msg =
                scope === 'always'
                  ? `✅ Permission **accepted** (auto-approve similar requests)`
                  : `✅ Permission **accepted**`
              await command.reply(msg)
              sessionLogger.log(
                `Permission ${pending.permission.id} accepted with scope: ${scope}`,
              )
            } catch (error) {
              voiceLogger.error('[ACCEPT] Error:', error)
              await command.reply({
                content: `Failed to accept permission: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ephemeral: true,
              })
            }
          } else if (command.commandName === 'reject') {
            const channel = command.channel

            if (!channel) {
              await command.reply({
                content: 'This command can only be used in a channel',
                ephemeral: true,
              })
              return
            }

            const isThread = [
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
              ChannelType.AnnouncementThread,
            ].includes(channel.type)

            if (!isThread) {
              await command.reply({
                content: 'This command can only be used in a thread with an active session',
                ephemeral: true,
              })
              return
            }

            const pending = pendingPermissions.get(channel.id)
            if (!pending) {
              await command.reply({
                content: 'No pending permission request in this thread',
                ephemeral: true,
              })
              return
            }

            try {
              const getClient = await initializeOpencodeForDirectory(pending.directory)
              await getClient().postSessionIdPermissionsPermissionId({
                path: {
                  id: pending.permission.sessionID,
                  permissionID: pending.permission.id,
                },
                body: {
                  response: 'reject',
                },
              })

              pendingPermissions.delete(channel.id)
              await command.reply(`❌ Permission **rejected**`)
              sessionLogger.log(`Permission ${pending.permission.id} rejected`)
            } catch (error) {
              voiceLogger.error('[REJECT] Error:', error)
              await command.reply({
                content: `Failed to reject permission: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ephemeral: true,
              })
            }
          } else if (command.commandName === 'abort') {
            const channel = command.channel

            if (!channel) {
              await command.reply({
                content: 'This command can only be used in a channel',
                ephemeral: true,
              })
              return
            }

            const isThread = [
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
              ChannelType.AnnouncementThread,
            ].includes(channel.type)

            if (!isThread) {
              await command.reply({
                content: 'This command can only be used in a thread with an active session',
                ephemeral: true,
              })
              return
            }

            const textChannel = resolveTextChannel(channel as ThreadChannel)
            const { projectDirectory: directory } = getKimakiMetadata(textChannel)

            if (!directory) {
              await command.reply({
                content: 'Could not determine project directory for this channel',
                ephemeral: true,
              })
              return
            }

            const row = getDatabase()
              .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
              .get(channel.id) as { session_id: string } | undefined

            if (!row?.session_id) {
              await command.reply({
                content: 'No active session in this thread',
                ephemeral: true,
              })
              return
            }

            const sessionId = row.session_id

            try {
              const existingController = abortControllers.get(sessionId)
              if (existingController) {
                existingController.abort(new Error('User requested abort'))
                abortControllers.delete(sessionId)
              }

              const getClient = await initializeOpencodeForDirectory(directory)
              await getClient().session.abort({
                path: { id: sessionId },
              })

              await command.reply(`🛑 Request **aborted**`)
              sessionLogger.log(`Session ${sessionId} aborted by user`)
            } catch (error) {
              voiceLogger.error('[ABORT] Error:', error)
              await command.reply({
                content: `Failed to abort: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ephemeral: true,
              })
            }
          }
        }
      } catch (error) {
        voiceLogger.error('[INTERACTION] Error handling interaction:', error)
      }
    },
  )

  // Helper function to clean up voice connection and associated resources
  async function cleanupVoiceConnection(guildId: string) {
    const voiceData = voiceConnections.get(guildId)
    if (!voiceData) return

    voiceLogger.log(`Starting cleanup for guild ${guildId}`)

    try {
      // Stop GenAI worker if exists (this is async!)
      if (voiceData.genAiWorker) {
        voiceLogger.log(`Stopping GenAI worker...`)
        await voiceData.genAiWorker.stop()
        voiceLogger.log(`GenAI worker stopped`)
      }

      // Close user audio stream if exists
      if (voiceData.userAudioStream) {
        voiceLogger.log(`Closing user audio stream...`)
        await new Promise<void>((resolve) => {
          voiceData.userAudioStream!.end(() => {
            voiceLogger.log('User audio stream closed')
            resolve()
          })
          // Timeout after 2 seconds
          setTimeout(resolve, 2000)
        })
      }

      // Destroy voice connection
      if (
        voiceData.connection.state.status !== VoiceConnectionStatus.Destroyed
      ) {
        voiceLogger.log(`Destroying voice connection...`)
        voiceData.connection.destroy()
      }

      // Remove from map
      voiceConnections.delete(guildId)
      voiceLogger.log(`Cleanup complete for guild ${guildId}`)
    } catch (error) {
      voiceLogger.error(`Error during cleanup for guild ${guildId}:`, error)
      // Still remove from map even if there was an error
      voiceConnections.delete(guildId)
    }
  }

  // Handle voice state updates
  discordClient.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
      const member = newState.member || oldState.member
      if (!member) return

      // Check if user is admin or server owner
      const guild = newState.guild || oldState.guild
      const isOwner = member.id === guild.ownerId
      const isAdmin = member.permissions.has(
        PermissionsBitField.Flags.Administrator,
      )

      if (!isOwner && !isAdmin) {
        // Not an admin user, ignore
        return
      }

      // Handle admin leaving voice channel
      if (oldState.channelId !== null && newState.channelId === null) {
        voiceLogger.log(
          `Admin user ${member.user.tag} left voice channel: ${oldState.channel?.name}`,
        )

        // Check if bot should leave too
        const guildId = guild.id
        const voiceData = voiceConnections.get(guildId)

        if (
          voiceData &&
          voiceData.connection.joinConfig.channelId === oldState.channelId
        ) {
          // Check if any other admin is still in the channel
          const voiceChannel = oldState.channel as VoiceChannel
          if (!voiceChannel) return

          const hasOtherAdmins = voiceChannel.members.some((m) => {
            if (m.id === member.id || m.user.bot) return false
            return (
              m.id === guild.ownerId ||
              m.permissions.has(PermissionsBitField.Flags.Administrator)
            )
          })

          if (!hasOtherAdmins) {
            voiceLogger.log(
              `No other admins in channel, bot leaving voice channel in guild: ${guild.name}`,
            )

            // Properly clean up all resources
            await cleanupVoiceConnection(guildId)
          } else {
            voiceLogger.log(
              `Other admins still in channel, bot staying in voice channel`,
            )
          }
        }
        return
      }

      // Handle admin moving between voice channels
      if (
        oldState.channelId !== null &&
        newState.channelId !== null &&
        oldState.channelId !== newState.channelId
      ) {
        voiceLogger.log(
          `Admin user ${member.user.tag} moved from ${oldState.channel?.name} to ${newState.channel?.name}`,
        )

        // Check if we need to follow the admin
        const guildId = guild.id
        const voiceData = voiceConnections.get(guildId)

        if (
          voiceData &&
          voiceData.connection.joinConfig.channelId === oldState.channelId
        ) {
          // Check if any other admin is still in the old channel
          const oldVoiceChannel = oldState.channel as VoiceChannel
          if (oldVoiceChannel) {
            const hasOtherAdmins = oldVoiceChannel.members.some((m) => {
              if (m.id === member.id || m.user.bot) return false
              return (
                m.id === guild.ownerId ||
                m.permissions.has(PermissionsBitField.Flags.Administrator)
              )
            })

            if (!hasOtherAdmins) {
              voiceLogger.log(
                `Following admin to new channel: ${newState.channel?.name}`,
              )
              const voiceChannel = newState.channel as VoiceChannel
              if (voiceChannel) {
                voiceData.connection.rejoin({
                  channelId: voiceChannel.id,
                  selfDeaf: false,
                  selfMute: false,
                })
              }
            } else {
              voiceLogger.log(
                `Other admins still in old channel, bot staying put`,
              )
            }
          }
        }
      }

      // Handle admin joining voice channel (initial join)
      if (oldState.channelId === null && newState.channelId !== null) {
        voiceLogger.log(
          `Admin user ${member.user.tag} (Owner: ${isOwner}, Admin: ${isAdmin}) joined voice channel: ${newState.channel?.name}`,
        )
      }

      // Only proceed with joining if this is a new join or channel move
      if (newState.channelId === null) return

      const voiceChannel = newState.channel as VoiceChannel
      if (!voiceChannel) return

      // Check if bot already has a connection in this guild
      const existingVoiceData = voiceConnections.get(newState.guild.id)
      if (
        existingVoiceData &&
        existingVoiceData.connection.state.status !==
          VoiceConnectionStatus.Destroyed
      ) {
        voiceLogger.log(
          `Bot already connected to a voice channel in guild ${newState.guild.name}`,
        )

        // If bot is in a different channel, move to the admin's channel
        if (
          existingVoiceData.connection.joinConfig.channelId !== voiceChannel.id
        ) {
          voiceLogger.log(
            `Moving bot from channel ${existingVoiceData.connection.joinConfig.channelId} to ${voiceChannel.id}`,
          )
          existingVoiceData.connection.rejoin({
            channelId: voiceChannel.id,
            selfDeaf: false,
            selfMute: false,
          })
        }
        return
      }

      try {
        // Join the voice channel
        voiceLogger.log(
          `Attempting to join voice channel: ${voiceChannel.name} (${voiceChannel.id})`,
        )

        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: newState.guild.id,
          adapterCreator: newState.guild.voiceAdapterCreator,
          selfDeaf: false,
          debug: true,
          daveEncryption: false,

          selfMute: false, // Not muted so bot can speak
        })

        // Store the connection
        voiceConnections.set(newState.guild.id, { connection })

        // Wait for connection to be ready
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000)
        voiceLogger.log(
          `Successfully joined voice channel: ${voiceChannel.name} in guild: ${newState.guild.name}`,
        )

        // Set up voice handling (only once per connection)
        await setupVoiceHandling({
          connection,
          guildId: newState.guild.id,
          channelId: voiceChannel.id,
          appId: currentAppId!,
          discordClient,
        })

        // Handle connection state changes
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
          voiceLogger.log(
            `Disconnected from voice channel in guild: ${newState.guild.name}`,
          )
          try {
            // Try to reconnect
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ])
            voiceLogger.log(`Reconnecting to voice channel`)
          } catch (error) {
            // Seems to be a real disconnect, destroy the connection
            voiceLogger.log(`Failed to reconnect, destroying connection`)
            connection.destroy()
            voiceConnections.delete(newState.guild.id)
          }
        })

        connection.on(VoiceConnectionStatus.Destroyed, async () => {
          voiceLogger.log(
            `Connection destroyed for guild: ${newState.guild.name}`,
          )
          // Use the cleanup function to ensure everything is properly closed
          await cleanupVoiceConnection(newState.guild.id)
        })

        // Handle errors
        connection.on('error', (error) => {
          voiceLogger.error(
            `Connection error in guild ${newState.guild.name}:`,
            error,
          )
        })
      } catch (error) {
        voiceLogger.error(`Failed to join voice channel:`, error)
        await cleanupVoiceConnection(newState.guild.id)
      }
    } catch (error) {
      voiceLogger.error('Error in voice state update handler:', error)
    }
  })

  await discordClient.login(token)

  const handleShutdown = async (signal: string) => {
    discordLogger.log(`Received ${signal}, cleaning up...`)

    // Prevent multiple shutdown calls
    if ((global as any).shuttingDown) {
      discordLogger.log('Already shutting down, ignoring duplicate signal')
      return
    }
    ;(global as any).shuttingDown = true

    try {
      // Clean up all voice connections (this includes GenAI workers and audio streams)
      const cleanupPromises: Promise<void>[] = []
      for (const [guildId] of voiceConnections) {
        voiceLogger.log(
          `[SHUTDOWN] Cleaning up voice connection for guild ${guildId}`,
        )
        cleanupPromises.push(cleanupVoiceConnection(guildId))
      }

      // Wait for all cleanups to complete
      if (cleanupPromises.length > 0) {
        voiceLogger.log(
          `[SHUTDOWN] Waiting for ${cleanupPromises.length} voice connection(s) to clean up...`,
        )
        await Promise.allSettled(cleanupPromises)
        discordLogger.log(`All voice connections cleaned up`)
      }

      // Kill all OpenCode servers
      for (const [dir, server] of opencodeServers) {
        if (!server.process.killed) {
          voiceLogger.log(
            `[SHUTDOWN] Stopping OpenCode server on port ${server.port} for ${dir}`,
          )
          server.process.kill('SIGTERM')
        }
      }
      opencodeServers.clear()

      discordLogger.log('Closing database...')
      if (db) {
        db.close()
        db = null
      }

      discordLogger.log('Destroying Discord client...')
      discordClient.destroy()

      discordLogger.log('Cleanup complete, exiting.')
      process.exit(0)
    } catch (error) {
      voiceLogger.error('[SHUTDOWN] Error during cleanup:', error)
      process.exit(1)
    }
  }

  // Override default signal handlers to prevent immediate exit
  process.on('SIGTERM', async () => {
    try {
      await handleShutdown('SIGTERM')
    } catch (error) {
      voiceLogger.error('[SIGTERM] Error during shutdown:', error)
      process.exit(1)
    }
  })

  process.on('SIGINT', async () => {
    try {
      await handleShutdown('SIGINT')
    } catch (error) {
      voiceLogger.error('[SIGINT] Error during shutdown:', error)
      process.exit(1)
    }
  })

  // Prevent unhandled promise rejections from crashing the process during shutdown
  process.on('unhandledRejection', (reason, promise) => {
    if ((global as any).shuttingDown) {
      discordLogger.log('Ignoring unhandled rejection during shutdown:', reason)
      return
    }
    discordLogger.error('Unhandled Rejection at:', promise, 'reason:', reason)
  })
}
