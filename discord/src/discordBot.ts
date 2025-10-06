import {
  createOpencodeClient,
  type OpencodeClient,
  type Part,
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
}: {
  connection: VoiceConnection
  guildId: string
  channelId: string
  appId: string
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
    onError(error) {
      voiceLogger.error('GenAI worker error:', error)
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
    // Create ~/.kimaki directory if it doesn't exist
    const kimakiDir = path.join(os.homedir(), '.kimaki')

    try {
      fs.mkdirSync(kimakiDir, { recursive: true })
    } catch (error) {
      dbLogger.error('Failed to create ~/.kimaki directory:', error)
    }

    const dbPath = path.join(kimakiDir, 'discord-sessions.db')

    dbLogger.log(`Opening database at: ${dbPath}`)
    db = new Database(dbPath)

    // Initialize tables
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

  // Simple case: content fits in one message
  if (content.length <= MAX_LENGTH) {
    return await thread.send(content)
  }

  // Use marked's lexer to tokenize markdown content
  const lexer = new Lexer()
  const tokens = lexer.lex(content)

  const chunks: string[] = []
  let currentChunk = ''

  // Process each token and add to chunks
  for (const token of tokens) {
    const tokenText = token.raw || ''

    // If adding this token would exceed limit and we have content, flush current chunk
    if (currentChunk && currentChunk.length + tokenText.length > MAX_LENGTH) {
      chunks.push(currentChunk)
      currentChunk = ''
    }

    // If this single token is longer than MAX_LENGTH, split it
    if (tokenText.length > MAX_LENGTH) {
      if (currentChunk) {
        chunks.push(currentChunk)
        currentChunk = ''
      }

      let remainingText = tokenText
      while (remainingText.length > MAX_LENGTH) {
        // Try to split at a newline if possible
        let splitIndex = MAX_LENGTH
        const newlineIndex = remainingText.lastIndexOf('\n', MAX_LENGTH - 1)
        if (newlineIndex > MAX_LENGTH * 0.7) {
          splitIndex = newlineIndex + 1
        }

        chunks.push(remainingText.slice(0, splitIndex))
        remainingText = remainingText.slice(splitIndex)
      }
      currentChunk = remainingText
    } else {
      currentChunk += tokenText
    }
  }

  // Add any remaining content
  if (currentChunk) {
    chunks.push(currentChunk)
  }

  // Send all chunks
  discordLogger.log(
    `MESSAGE: Splitting ${content.length} chars into ${chunks.length} messages`,
  )

  let firstMessage: Message | undefined
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (!chunk) continue
    const message = await thread.send(chunk)
    if (i === 0) firstMessage = message
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

function formatPart(part: Part): string {
  switch (part.type) {
    case 'text':
      return escapeDiscordFormatting(part.text || '')
    case 'reasoning':
      if (!part.text?.trim()) return ''
      return `▪︎ thinking: ${escapeDiscordFormatting(part.text || '')}`
    case 'tool':
      if (part.state.status === 'completed' || part.state.status === 'error') {
        // console.log(part)
        // Escape triple backticks so Discord does not break code blocks
        let language = ''
        let outputToDisplay = ''
        if (part.tool === 'bash') {
          outputToDisplay =
            part.state.status === 'completed'
              ? part.state.output
              : part.state.error
          outputToDisplay ||= ''
        }
        if (part.tool === 'edit') {
          outputToDisplay = (part.state.input?.newString as string) || ''
          language = path.extname((part.state.input.filePath as string) || '')
        }
        if (part.tool === 'todowrite') {
          const todos =
            (part.state.input?.todos as {
              content: string
              status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
            }[]) || []
          outputToDisplay = todos
            .map((todo) => {
              let statusIcon = '▢'
              switch (todo.status) {
                case 'pending':
                  statusIcon = '▢'
                  break
                case 'in_progress':
                  statusIcon = '●'
                  break
                case 'completed':
                  statusIcon = '■'
                  break
                case 'cancelled':
                  statusIcon = '■'
                  break
              }
              return `\`${statusIcon}\` ${todo.content}`
            })
            .filter(Boolean)
            .join('\n')
          language = ''
        }
        if (part.tool === 'write') {
          outputToDisplay = (part.state.input?.content as string) || ''
          language = path.extname((part.state.input.filePath as string) || '')
        }
        outputToDisplay =
          outputToDisplay.length > 500
            ? outputToDisplay.slice(0, 497) + `…`
            : outputToDisplay

        // Escape Discord formatting characters that could break code blocks
        outputToDisplay = escapeDiscordFormatting(outputToDisplay)

        let toolTitle =
          part.state.status === 'completed' ? part.state.title || '' : 'error'
        // Escape backticks in the title before wrapping in backticks
        if (toolTitle) {
          toolTitle = `\`${escapeInlineCode(toolTitle)}\``
        }
        const icon =
          part.state.status === 'completed'
            ? '◼︎'
            : part.state.status === 'error'
              ? '⨯'
              : ''
        const title = `${icon} ${part.tool} ${toolTitle}`

        let text = title

        if (outputToDisplay) {
          // Don't wrap todowrite output in code blocks
          if (part.tool === 'todowrite') {
            text += '\n\n' + outputToDisplay
          } else {
            if (language.startsWith('.')) {
              language = language.slice(1)
            }
            text += '\n\n```' + language + '\n' + outputToDisplay + '\n```'
          }
        }
        return text
      }
      return ''
    case 'file':
      return `📄 ${part.filename || 'File'}`
    case 'step-start':
    case 'step-finish':
    case 'patch':
      return ''
    case 'agent':
      return `◼︎ agent ${part.id}`
    case 'snapshot':
      return `◼︎ snapshot ${part.snapshot}`
    default:
      discordLogger.warn('Unknown part type:', part)
      return ''
  }
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

async function handleOpencodeSession(
  prompt: string,
  thread: ThreadChannel,
  projectDirectory?: string,
  originalMessage?: Message,
) {
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
    existingController.abort('New request started')
  }

  if (abortControllers.has(session.id)) {
    abortControllers.get(session.id)?.abort('new reply')
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

  const sendPartMessage = async (part: Part) => {
    const content = formatPart(part) + '\n\n'
    if (!content.trim() || content.length === 0) {
      discordLogger.log(`SKIP: Part ${part.id} has no content`)
      return
    }

    // Skip if already sent
    if (partIdToMessage.has(part.id)) {
      voiceLogger.log(
        `[SEND SKIP] Part ${part.id} already sent as message ${partIdToMessage.get(part.id)?.id}`,
      )
      return
    }

    try {
      voiceLogger.log(
        `[SEND] Sending part ${part.id} (type: ${part.type}) to Discord, content length: ${content.length}`,
      )

      const firstMessage = await sendThreadMessage(thread, content)
      partIdToMessage.set(part.id, firstMessage)
      voiceLogger.log(
        `[SEND SUCCESS] Part ${part.id} sent as message ${firstMessage.id}`,
      )

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
      discordLogger.log(`Starting typing for thread ${thread.id}`)

      // Clear any previous typing interval
      if (typingInterval) {
        clearInterval(typingInterval)
        typingInterval = null
        discordLogger.log(`Cleared previous typing interval`)
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
          discordLogger.log(`Stopped typing for thread ${thread.id}`)
        }
      }
    }

    try {
      let assistantMessageId: string | undefined

      for await (const event of events) {
        sessionLogger.log(`Received: ${event.type}`)
        if (event.type === 'message.updated') {
          const msg = event.properties.info

          if (msg.sessionID !== session.id) {
            voiceLogger.log(
              `[EVENT IGNORED] Message from different session (expected: ${session.id}, got: ${msg.sessionID})`,
            )
            continue
          }

          // Track assistant message ID
          if (msg.role === 'assistant') {
            assistantMessageId = msg.id
            voiceLogger.log(
              `[EVENT] Tracking assistant message ${assistantMessageId}`,
            )
          } else {
            sessionLogger.log(`Message role: ${msg.role}`)
          }
        } else if (event.type === 'message.part.updated') {
          const part = event.properties.part

          if (part.sessionID !== session.id) {
            voiceLogger.log(
              `[EVENT IGNORED] Part from different session (expected: ${session.id}, got: ${part.sessionID})`,
            )
            continue
          }

          // Only process parts from assistant messages
          if (part.messageID !== assistantMessageId) {
            voiceLogger.log(
              `[EVENT IGNORED] Part from non-assistant message (expected: ${assistantMessageId}, got: ${part.messageID})`,
            )
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

          voiceLogger.log(
            `[PART] Update: id=${part.id}, type=${part.type}, text=${'text' in part && typeof part.text === 'string' ? part.text.slice(0, 50) : ''}`,
          )

          // Start typing on step-start
          if (part.type === 'step-start') {
            stopTyping = startTyping(thread)
          }

          // Check if this is a step-finish part
          if (part.type === 'step-finish') {
            // Send all parts accumulated so far to Discord
            voiceLogger.log(
              `[STEP-FINISH] Sending ${currentParts.length} parts to Discord`,
            )
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
        } else if (event.type === 'file.edited') {
          sessionLogger.log(`File edited event received`)
        } else {
          sessionLogger.log(`Unhandled event type: ${event.type}`)
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
      voiceLogger.log(
        `[CLEANUP] Checking ${currentParts.length} parts for unsent messages`,
      )
      let unsentCount = 0
      for (const part of currentParts) {
        if (!partIdToMessage.has(part.id)) {
          unsentCount++
          voiceLogger.log(
            `[CLEANUP] Sending unsent part: id=${part.id}, type=${part.type}`,
          )
          try {
            await sendPartMessage(part)
          } catch (error) {
            sessionLogger.log(
              `Failed to send part ${part.id} during cleanup:`,
              error,
            )
          }
        }
      }
      if (unsentCount === 0) {
        sessionLogger.log(`All parts were already sent`)
      } else {
        sessionLogger.log(`Sent ${unsentCount} previously unsent parts`)
      }

      // Stop typing when session ends
      if (stopTyping) {
        stopTyping()
        stopTyping = null
        sessionLogger.log(`Stopped typing for session`)
      }

      // Only send duration message if request was not aborted or was aborted with 'finished' reason
      if (
        !abortController.signal.aborted ||
        abortController.signal.reason === 'finished'
      ) {
        const sessionDuration = prettyMilliseconds(
          Date.now() - sessionStartTime,
        )
        await sendThreadMessage(thread, `_Completed in ${sessionDuration}_`)
        sessionLogger.log(`DURATION: Session completed in ${sessionDuration}`)
      } else {
        sessionLogger.log(
          `Session was aborted (reason: ${abortController.signal.reason}), skipping duration message`,
        )
      }
    }
  }

  try {
    voiceLogger.log(
      `[PROMPT] Sending prompt to session ${session.id}: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`,
    )

    // Start the event handler
    const eventHandlerPromise = eventHandler()

    const response = await getClient().session.prompt({
      path: { id: session.id },
      body: {
        parts: [{ type: 'text', text: prompt }],
      },
      signal: abortController.signal,
    })
    abortController.abort('finished')

    sessionLogger.log(`Successfully sent prompt, got response`)

    abortControllers.delete(session.id)

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

    return { sessionID: session.id, result: response.data }
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
      await sendThreadMessage(
        thread,
        `✗ Unexpected bot Error: ${error instanceof Error ? error.stack || error.message : String(error)}`,
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
        voiceLogger.log(
          `[IGNORED] Bot message from ${message.author.tag} in channel ${message.channelId}`,
        )
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
          voiceLogger.log(
            `[IGNORED] Non-authoritative user ${message.author.tag} (ID: ${message.author.id}) - not owner or admin`,
          )
          return
        }

        voiceLogger.log(
          `[AUTHORIZED] Message from ${message.author.tag} (Owner: ${isOwner}, Admin: ${isAdmin})`,
        )
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

        await handleOpencodeSession(
          messageContent,
          thread,
          projectDirectory,
          message,
        )
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

        await handleOpencodeSession(
          messageContent,
          thread,
          projectDirectory,
          message,
        )
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
                .map((session) => ({
                  name: `${session.title} (${new Date(session.time.updated).toLocaleString()})`,
                  value: session.id,
                }))

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
                  .slice(0, 25) // Discord limit
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

                await interaction.respond(choices)
              } catch (error) {
                voiceLogger.error('[AUTOCOMPLETE] Error fetching files:', error)
                await interaction.respond([])
              }
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
              await handleOpencodeSession(fullPrompt, thread, projectDirectory)
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

              // Render all existing messages
              let messageCount = 0
              for (const message of messages) {
                if (message.info.role === 'user') {
                  // Render user messages
                  const userParts = message.parts.filter(
                    (p) => p.type === 'text' && !p.synthetic,
                  )
                  const userTexts = userParts
                    .map((p) => {
                      if (p.type === 'text') {
                        return p.text
                      }
                      return ''
                    })
                    .filter((t) => t.trim())

                  const userText = userTexts.join('\n\n')
                  if (userText) {
                    // Escape backticks in user messages to prevent formatting issues
                    const escapedText = escapeDiscordFormatting(userText)
                    await sendThreadMessage(thread, `**User:**\n${escapedText}`)
                  }
                } else if (message.info.role === 'assistant') {
                  // Render assistant parts
                  for (const part of message.parts) {
                    const content = formatPart(part)
                    if (content.trim()) {
                      const discordMessage = await sendThreadMessage(
                        thread,
                        content,
                      )

                      // Store part-message mapping in database
                      getDatabase()
                        .prepare(
                          'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)',
                        )
                        .run(part.id, discordMessage.id, thread.id)
                    }
                  }
                }
                messageCount++
              }

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
