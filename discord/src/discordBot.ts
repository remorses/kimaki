import {
  createOpencodeClient,
  type OpencodeClient,
  type Part,
} from '@opencode-ai/sdk'
import { $ } from 'bun'
import { Database } from 'bun:sqlite'
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
  createAudioPlayer,
  createAudioResource,
  StreamType,
  EndBehaviorType,
  type VoiceConnection,
} from '@discordjs/voice'
import { Lexer } from 'marked'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { PassThrough, Transform } from 'node:stream'
import * as prism from 'prism-media'
import { Resampler } from '@purinton/resampler'
import dedent from 'string-dedent'
import { transcribeAudio } from './voice'
import { extractTagsArrays } from './xml'
import prettyMilliseconds from 'pretty-ms'
import { startGenAiSession } from './genai'
import type { Session } from '@google/genai'

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
const activeRequests = new Map<string, AbortController>()

// Map of guild ID to voice connection and GenAI session
const voiceConnections = new Map<
  string,
  {
    connection: VoiceConnection
    genAiSession?: {
      session: Session
      stop: () => void
    }
  }
>()

let db: Database | null = null

// Helper: buffer arbitrary PCM chunks into exact 20ms frames at 16 kHz mono (s16le)
function makePcm16kMonoFramer() {
  const SAMPLES_PER_20MS = 320 // 16,000 Hz * 0.02s
  const FRAME_BYTES = SAMPLES_PER_20MS * 2 // 2 bytes (s16le) * 1 ch
  let stash = Buffer.alloc(0)
  const out = new PassThrough({ highWaterMark: FRAME_BYTES * 8 })

  return {
    stream: out, // emits exact 20ms frames of PCM s16le 16k mono
    pushPcm(buf: Buffer) {
      stash = Buffer.concat([stash, buf])
      while (stash.length >= FRAME_BYTES) {
        out.write(stash.subarray(0, FRAME_BYTES))
        stash = stash.subarray(FRAME_BYTES)
      }
    },
    end() {
      out.end()
    },
  }
}

// 20 ms @ 16 kHz mono s16le = 320 samples * 2 bytes = 640 bytes
const FRAME_BYTES = 640

function frame16kMono20ms() {
  let stash = Buffer.alloc(0)
  return new Transform({
    transform(chunk, _enc, cb) {
      stash = Buffer.concat([stash, chunk])
      while (stash.length >= FRAME_BYTES) {
        this.push(stash.subarray(0, FRAME_BYTES))
        stash = stash.subarray(FRAME_BYTES)
      }
      cb()
    },
    flush(cb) {
      // optionally push tail (not full 20 ms) — often better to drop it
      // if (stash.length) this.push(stash);
      cb()
    },
  })
}

export function getDatabase(): Database {
  if (!db) {
    db = new Database('discord-sessions.db')

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
  console.log(
    `[THREAD MESSAGE] Splitting ${content.length} chars into ${chunks.length} messages`,
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
            console.log(`OpenCode server ready on port ${port}`)
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
}: {
  message: Message
  thread: ThreadChannel
  projectDirectory?: string
  isNewThread?: boolean
}): Promise<string | null> {
  const audioAttachment = Array.from(message.attachments.values()).find(
    (attachment) => attachment.contentType?.startsWith('audio/'),
  )

  if (!audioAttachment) return null

  console.log(
    `[VOICE MESSAGE] Detected audio attachment: ${audioAttachment.name} (${audioAttachment.contentType})`,
  )

  try {
    await message.react('⏳')
    await sendThreadMessage(thread, '🎤 Transcribing voice message...')

    const audioResponse = await fetch(audioAttachment.url)
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer())

    console.log(
      `[VOICE MESSAGE] Downloaded ${audioBuffer.length} bytes, transcribing...`,
    )

    // Get project file tree for context if directory is provided
    let transcriptionPrompt = 'Discord voice message transcription'

    if (projectDirectory) {
      try {
        console.log(
          `[VOICE MESSAGE] Getting project file tree from ${projectDirectory}`,
        )
        // Use git ls-files to get tracked files, then pipe to tree
        const result =
          await $`cd ${projectDirectory} && git ls-files | tree --fromfile -a`.text()

        if (result) {
          transcriptionPrompt = `Discord voice message transcription. Project file structure:\n${result}\n\nPlease transcribe file names and paths accurately based on this context.`
          console.log(
            `[VOICE MESSAGE] Added project context to transcription prompt`,
          )
        }
      } catch (e) {
        console.log(`[VOICE MESSAGE] Could not get project tree:`, e)
      }
    }

    const transcription = await transcribeAudio({
      audio: audioBuffer,
      prompt: transcriptionPrompt,
    })

    console.log(
      `[VOICE MESSAGE] Transcription successful: "${transcription.slice(0, 50)}${transcription.length > 50 ? '...' : ''}"`,
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
          console.log(`[THREAD] Updated thread name to: "${threadName}"`)
        } catch (e) {
          console.log(`[THREAD] Could not update thread name:`, e)
        }
      }
    }

    await sendThreadMessage(
      thread,
      `📝 **Transcribed message:** ${escapeDiscordFormatting(transcription)}`,
    )
    return transcription
  } catch (error) {
    console.error(`[VOICE MESSAGE] Failed to transcribe audio:`, error)
    await sendThreadMessage(
      thread,
      `✗ Failed to transcribe voice message: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )

    try {
      await message.reactions.removeAll()
      await message.react('❌')
    } catch (e) {
      console.log(`[REACTION] Could not update reaction:`, e)
    }

    throw error
  }
}

/**
 * Escape Discord formatting characters to prevent breaking code blocks and inline code
 */
function escapeDiscordFormatting(text: string): string {
  return text
    .replace(/```/g, '\\`\\`\\`') // Triple backticks
    .replace(/``/g, '\\`\\`') // Double backticks
    .replace(/(?<!\\)`(?!`)/g, '\\`') // Single backticks (not already escaped or part of double/triple)
    .replace(/\|\|/g, '\\|\\|') // Double pipes (spoiler syntax)
}

export async function initializeOpencodeForDirectory(
  directory: string,
): Promise<OpencodeClient> {
  // console.log(`[OPENCODE] Initializing for directory: ${directory}`)

  // Check if we already have a server for this directory
  const existing = opencodeServers.get(directory)
  if (existing && !existing.process.killed) {
    console.log(
      `[OPENCODE] Reusing existing server on port ${existing.port} for directory: ${directory}`,
    )
    return existing.client
  }

  const port = await getOpenPort()
  // console.log(
  //   `[OPENCODE] Starting new server on port ${port} for directory: ${directory}`,
  // )

  const serverProcess = spawn(
    'opencode',
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
    console.log(`[OpenCode:${port}] ${data.toString().trim()}`)
  })

  serverProcess.stderr?.on('data', (data) => {
    console.error(`[OpenCode Error:${port}] ${data.toString().trim()}`)
  })

  serverProcess.on('error', (error) => {
    console.error(`Failed to start OpenCode server on port ${port}:`, error)
  })

  serverProcess.on('exit', (code) => {
    console.log(`OpenCode server on port ${port} exited with code:`, code)
    opencodeServers.delete(directory)
  })

  await waitForServer(port)
  const client = createOpencodeClient({ baseUrl: `http://localhost:${port}` })

  opencodeServers.set(directory, {
    process: serverProcess,
    client,
    port,
  })

  return client
}

function formatPart(part: Part): string {
  switch (part.type) {
    case 'text':
      return escapeDiscordFormatting(part.text || '')
    case 'reasoning':
      return `💭 ${escapeDiscordFormatting(part.text || '')}`
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
              let statusIcon = '□'
              switch (todo.status) {
                case 'pending':
                  statusIcon = '□'
                  break
                case 'in_progress':
                  statusIcon = '◈'
                  break
                case 'completed':
                  statusIcon = '☑'
                  break
                case 'cancelled':
                  statusIcon = '☒'
                  break
              }
              return `${statusIcon} ${todo.content}`
            })
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
          toolTitle = `\`${escapeDiscordFormatting(toolTitle)}\``
        }
        const icon =
          part.state.status === 'completed'
            ? '◼︎'
            : part.state.status === 'error'
              ? '✖️'
              : ''
        const title = `${icon} ${part.tool} ${toolTitle}`

        let text = title

        if (outputToDisplay) {
          // Don't wrap todowrite output in code blocks
          if (part.tool === 'todowrite') {
            text += '\n\n' + outputToDisplay
          } else {
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
      console.log('Unknown part type:', part)
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
  console.log(
    `[OPENCODE SESSION] Starting for thread ${thread.id} with prompt: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
  )

  // Track session start time
  const sessionStartTime = Date.now()

  // Add processing reaction to original message
  if (originalMessage) {
    try {
      await originalMessage.react('⏳')
      console.log(`[REACTION] Added processing reaction to message`)
    } catch (e) {
      console.log(`[REACTION] Could not add processing reaction:`, e)
    }
  }

  // Use default directory if not specified
  const directory = projectDirectory || process.cwd()
  console.log(`[OPENCODE SESSION] Using directory: ${directory}`)

  // Note: We'll cancel the existing request after we have the session ID

  const client = await initializeOpencodeForDirectory(directory)

  // Get session ID from database
  const row = getDatabase()
    .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
    .get(thread.id) as { session_id: string } | undefined
  let sessionId = row?.session_id
  let session

  if (sessionId) {
    console.log(`[SESSION] Attempting to reuse existing session ${sessionId}`)
    try {
      const sessionResponse = await client.session.get({
        path: { id: sessionId },
      })
      session = sessionResponse.data
      console.log(`[SESSION] Successfully reused session ${sessionId}`)
    } catch (error) {
      console.log(
        `[SESSION] Session ${sessionId} not found, will create new one`,
      )
    }
  }

  if (!session) {
    console.log(
      `[SESSION] Creating new session with title: "${prompt.slice(0, 80)}"`,
    )
    const sessionResponse = await client.session.create({
      body: { title: prompt.slice(0, 80) },
    })
    session = sessionResponse.data
    console.log(`[SESSION] Created new session ${session?.id}`)
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
  console.log(`[DATABASE] Stored session ${session.id} for thread ${thread.id}`)

  // Cancel any existing request for this session
  const existingController = activeRequests.get(session.id)
  if (existingController) {
    console.log(
      `[ABORT] Cancelling existing request for session: ${session.id}`,
    )
    existingController.abort('New request started')
  }

  const abortController = new AbortController()
  // Store this controller for this session
  activeRequests.set(session.id, abortController)

  const eventsResult = await client.event.subscribe({
    signal: abortController.signal,
  })
  const events = eventsResult.stream
  console.log(`[EVENTS] Subscribed to OpenCode events`)

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
      console.log(
        `Could not fetch message ${row.message_id} for part ${row.part_id}`,
      )
    }
  }

  let currentParts: Part[] = []
  let stopTyping: (() => void) | null = null

  const sendPartMessage = async (part: Part) => {
    const content = formatPart(part) + '\n\n'
    if (!content.trim() || content.length === 0) {
      console.log(`[SEND SKIP] Part ${part.id} has no content`)
      return
    }

    // Skip if already sent
    if (partIdToMessage.has(part.id)) {
      console.log(
        `[SEND SKIP] Part ${part.id} already sent as message ${partIdToMessage.get(part.id)?.id}`,
      )
      return
    }

    try {
      console.log(
        `[SEND] Sending part ${part.id} (type: ${part.type}) to Discord, content length: ${content.length}`,
      )

      const firstMessage = await sendThreadMessage(thread, content)
      partIdToMessage.set(part.id, firstMessage)
      console.log(
        `[SEND SUCCESS] Part ${part.id} sent as message ${firstMessage.id}`,
      )

      // Store part-message mapping in database
      getDatabase()
        .prepare(
          'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)',
        )
        .run(part.id, firstMessage.id, thread.id)
    } catch (error) {
      console.error(`[SEND ERROR] Failed to send part ${part.id}:`, error)
    }
  }

  const eventHandler = async () => {
    // Local typing function for this session
    // Outer-scoped interval for typing notifications. Only one at a time.
    let typingInterval: NodeJS.Timeout | null = null

    function startTyping(thread: ThreadChannel): () => void {
      if (abortController.signal.aborted) {
        console.log(`[TYPING] Not starting typing, already aborted`)
        return () => {}
      }
      console.log(`[TYPING] Starting typing for thread ${thread.id}`)

      // Clear any previous typing interval
      if (typingInterval) {
        clearInterval(typingInterval)
        typingInterval = null
        console.log(`[TYPING] Cleared previous typing interval`)
      }

      // Send initial typing
      thread.sendTyping().catch((e) => {
        console.log(`[TYPING] Failed to send initial typing: ${e}`)
      })

      // Set up interval to send typing every 8 seconds
      typingInterval = setInterval(() => {
        thread.sendTyping().catch((e) => {
          console.log(`[TYPING] Failed to send periodic typing: ${e}`)
        })
      }, 8000)
      abortController.signal.addEventListener('abort', () => {
        clearInterval(typingInterval!)
      })

      // Return stop function
      return () => {
        if (typingInterval) {
          clearInterval(typingInterval)
          typingInterval = null
          console.log(`[TYPING] Stopped typing for thread ${thread.id}`)
        }
      }
    }

    try {
      let assistantMessageId: string | undefined

      for await (const event of events) {
        console.log(`[EVENT] Received: ${event.type}`)
        if (event.type === 'message.updated') {
          const msg = event.properties.info

          if (msg.sessionID !== session.id) {
            console.log(
              `[EVENT IGNORED] Message from different session (expected: ${session.id}, got: ${msg.sessionID})`,
            )
            continue
          }

          // Track assistant message ID
          if (msg.role === 'assistant') {
            assistantMessageId = msg.id
            console.log(
              `[EVENT] Tracking assistant message ${assistantMessageId}`,
            )
          } else {
            console.log(`[EVENT] Message role: ${msg.role}`)
          }
        } else if (event.type === 'message.part.updated') {
          const part = event.properties.part

          if (part.sessionID !== session.id) {
            console.log(
              `[EVENT IGNORED] Part from different session (expected: ${session.id}, got: ${part.sessionID})`,
            )
            continue
          }

          // Only process parts from assistant messages
          if (part.messageID !== assistantMessageId) {
            console.log(
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

          console.log(
            `[PART] Update: id=${part.id}, type=${part.type}, text=${'text' in part && typeof part.text === 'string' ? part.text.slice(0, 50) : ''}`,
          )

          // Start typing on step-start
          if (part.type === 'step-start') {
            stopTyping = startTyping(thread)
          }

          // Check if this is a step-finish part
          if (part.type === 'step-finish') {
            // Send all parts accumulated so far to Discord
            console.log(
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
          console.error(`[SESSION ERROR]`, event.properties)
          if (event.properties.sessionID === session.id) {
            const errorData = event.properties.error
            const errorMessage = errorData?.data?.message || 'Unknown error'
            console.error(
              `[SESSION ERROR] Sending error to thread: ${errorMessage}`,
            )
            await sendThreadMessage(
              thread,
              `✗ opencode session error: ${errorMessage}`,
            )

            // Update reaction to error
            if (originalMessage) {
              try {
                await originalMessage.reactions.removeAll()
                await originalMessage.react('❌')
                console.log(
                  `[REACTION] Added error reaction due to session error`,
                )
              } catch (e) {
                console.log(`[REACTION] Could not update reaction:`, e)
              }
            }
          } else {
            console.log(
              `[SESSION ERROR IGNORED] Error for different session (expected: ${session.id}, got: ${event.properties.sessionID})`,
            )
          }
          break
        } else if (event.type === 'file.edited') {
          console.log(`[EVENT] File edited event received`)
        } else {
          console.log(`[EVENT] Unhandled event type: ${event.type}`)
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        // Ignore abort controller errors as requested
        console.log('AbortController aborted event handling (normal exit)')
        return
      }
      console.error(`unexpected error in event handling code`, e)
      throw e
    } finally {
      // Send any remaining parts that weren't sent
      console.log(
        `[CLEANUP] Checking ${currentParts.length} parts for unsent messages`,
      )
      let unsentCount = 0
      for (const part of currentParts) {
        if (!partIdToMessage.has(part.id)) {
          unsentCount++
          console.log(
            `[CLEANUP] Sending unsent part: id=${part.id}, type=${part.type}`,
          )
          try {
            await sendPartMessage(part)
          } catch (error) {
            console.log(
              `[CLEANUP] Failed to send part ${part.id} during cleanup:`,
              error,
            )
          }
        }
      }
      if (unsentCount === 0) {
        console.log(`[CLEANUP] All parts were already sent`)
      } else {
        console.log(`[CLEANUP] Sent ${unsentCount} previously unsent parts`)
      }

      // Stop typing when session ends
      if (stopTyping) {
        stopTyping()
        stopTyping = null
        console.log(`[CLEANUP] Stopped typing for session`)
      }

      // Send duration message
      const sessionDuration = prettyMilliseconds(Date.now() - sessionStartTime)
      await sendThreadMessage(thread, `_Completed in ${sessionDuration}_`)
      console.log(`[SESSION DURATION] Session completed in ${sessionDuration}`)
    }
  }

  try {
    console.log(
      `[PROMPT] Sending prompt to session ${session.id}: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`,
    )

    // Start the event handler
    const eventHandlerPromise = eventHandler()

    const response = await client.session.prompt({
      path: { id: session.id },
      body: {
        parts: [{ type: 'text', text: prompt }],
      },
    })
    abortController.abort('finished')

    console.log(`[PROMPT] Successfully sent prompt, got response`)
    // Remove the controller after successful completion
    activeRequests.delete(session.id)

    // Update reaction to success
    if (originalMessage) {
      try {
        await originalMessage.reactions.removeAll()
        await originalMessage.react('✅')
        console.log(`[REACTION] Added success reaction to message`)
      } catch (e) {
        console.log(`[REACTION] Could not update reaction:`, e)
      }
    }

    return { sessionID: session.id, result: response.data }
  } catch (error) {
    console.error(`[PROMPT ERROR] Failed to send prompt:`, error)
    // Remove the controller on error
    activeRequests.delete(session.id)

    // Update reaction to error
    if (originalMessage) {
      try {
        await originalMessage.reactions.removeAll()
        await originalMessage.react('❌')
        console.log(`[REACTION] Added error reaction to message`)
      } catch (e) {
        console.log(`[REACTION] Could not update reaction:`, e)
      }
    }

    // Only show error message if not aborted by a new request
    if (!(error instanceof Error && error.name === 'AbortError')) {
      await sendThreadMessage(
        thread,
        `✗ Unexpected bot Error: ${error instanceof Error ? error.stack || error.message : String(error)}`,
      )
    }
    throw error
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
    console.log(`[READY] Discord bot logged in as ${c.user.tag}`)
    console.log(`[READY] Connected to ${c.guilds.cache.size} guild(s)`)
    console.log(`[READY] Bot user ID: ${c.user.id}`)

    // If appId wasn't provided, fetch it from the application
    if (!currentAppId) {
      await c.application?.fetch()
      currentAppId = c.application?.id

      if (!currentAppId) {
        console.error('[ERROR] Could not get application ID')
        throw new Error('Failed to get bot application ID')
      }
      console.log(`[READY] Bot Application ID (fetched): ${currentAppId}`)
    } else {
      console.log(`[READY] Bot Application ID (provided): ${currentAppId}`)
    }

    // List all guilds and channels that belong to this bot
    for (const guild of c.guilds.cache.values()) {
      console.log(`[GUILD] ${guild.name} (${guild.id})`)

      const channels = await getChannelsWithDescriptions(guild)
      // Only show channels that belong to this bot
      const kimakiChannels = channels.filter(
        (ch) =>
          ch.kimakiDirectory &&
          (!ch.kimakiApp || ch.kimakiApp === currentAppId),
      )

      if (kimakiChannels.length > 0) {
        console.log(`  Found ${kimakiChannels.length} channel(s) for this bot:`)
        for (const channel of kimakiChannels) {
          console.log(`  - #${channel.name}: ${channel.kimakiDirectory}`)
        }
      } else {
        console.log(`  No channels for this bot`)
      }
    }

    console.log(
      `[READY] Bot is ready and will only respond to channels with app ID: ${currentAppId}`,
    )
  })

  discordClient.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author?.bot) {
        console.log(
          `[IGNORED] Bot message from ${message.author.tag} in channel ${message.channelId}`,
        )
        return
      }
      if (message.partial) {
        console.log(`[PARTIAL] Fetching partial message ${message.id}`)
        try {
          await message.fetch()
        } catch (error) {
          console.log(
            `[IGNORED] Failed to fetch partial message ${message.id}:`,
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
          console.log(
            `[IGNORED] Non-authoritative user ${message.author.tag} (ID: ${message.author.id}) - not owner or admin`,
          )
          return
        }

        console.log(
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
        console.log(`[THREAD] Message in thread ${thread.name} (${thread.id})`)

        const row = getDatabase()
          .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
          .get(thread.id) as { session_id: string } | undefined

        if (!row) {
          console.log(`[IGNORED] No session found for thread ${thread.id}`)
          return
        }

        console.log(
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
          console.log(
            `[IGNORED] Thread belongs to different bot app (expected: ${currentAppId}, got: ${channelAppId})`,
          )
          return
        }

        if (projectDirectory && !fs.existsSync(projectDirectory)) {
          console.log(`[ERROR] Directory does not exist: ${projectDirectory}`)
          await sendThreadMessage(
            thread,
            `✗ Directory does not exist: ${JSON.stringify(projectDirectory)}`,
          )
          return
        }

        // Handle voice message if present
        let messageContent = message.content || ''
        try {
          const transcription = await processVoiceAttachment({
            message,
            thread,
            projectDirectory,
          })
          if (transcription) {
            messageContent = transcription
          }
        } catch (error) {
          return // Error already handled in processVoiceAttachment
        }

        try {
          await handleOpencodeSession(
            messageContent,
            thread,
            projectDirectory,
            message,
          )
        } catch (error) {
          if (!(error instanceof Error && error.name === 'AbortError')) {
            throw error
          }
        }
        return
      }

      // For text channels, start new sessions with kimaki.directory tag
      if (channel.type === ChannelType.GuildText) {
        const textChannel = channel as TextChannel
        console.log(
          `[GUILD_TEXT] Message in text channel #${textChannel.name} (${textChannel.id})`,
        )

        if (!textChannel.topic) {
          console.log(
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
          console.log(
            `[IGNORED] Channel #${textChannel.name} has no kimaki.directory tag`,
          )
          return
        }

        // Check if this channel belongs to current bot instance
        if (channelAppId && channelAppId !== currentAppId) {
          console.log(
            `[IGNORED] Channel belongs to different bot app (expected: ${currentAppId}, got: ${channelAppId})`,
          )
          return
        }

        console.log(`[DIRECTORY] Found kimaki.directory: ${projectDirectory}`)
        if (channelAppId) {
          console.log(`[APP] Channel app ID: ${channelAppId}`)
        }

        if (!fs.existsSync(projectDirectory)) {
          console.log(`[ERROR] Directory does not exist: ${projectDirectory}`)
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

        console.log(`[THREAD] Created thread "${thread.name}" (${thread.id})`)

        // Handle voice message if present
        let messageContent = message.content || ''
        try {
          const transcription = await processVoiceAttachment({
            message,
            thread,
            projectDirectory,
            isNewThread: true,
          })
          if (transcription) {
            messageContent = transcription
          }
        } catch (error) {
          return // Error already handled in processVoiceAttachment
        }

        await handleOpencodeSession(
          messageContent,
          thread,
          projectDirectory,
          message,
        )
      } else {
        console.log(`[IGNORED] Channel type ${channel.type} is not supported`)
      }
    } catch (error) {
      console.error('Discord handler error:', error)
      try {
        const errMsg = error instanceof Error ? error.message : String(error)
        await message.reply(`Error: ${errMsg}`)
      } catch {
        console.error('Discord handler error (fallback):', error)
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
              const textChannel = interaction.channel as TextChannel
              if (textChannel.topic) {
                const extracted = extractTagsArrays({
                  xml: textChannel.topic,
                  tags: ['kimaki.directory'],
                })
                projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
              }
            }

            if (!projectDirectory) {
              await interaction.respond([])
              return
            }

            try {
              // Get OpenCode client for this directory
              const client =
                await initializeOpencodeForDirectory(projectDirectory)

              // List sessions
              const sessionsResponse = await client.session.list()
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
              console.error('[AUTOCOMPLETE] Error fetching sessions:', error)
              await interaction.respond([])
            }
          }
        }

        // Handle slash commands
        if (interaction.isChatInputCommand()) {
          const command = interaction

          if (command.commandName === 'resume') {
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
              const client =
                await initializeOpencodeForDirectory(projectDirectory)

              // Get session title
              const sessionResponse = await client.session.get({
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

              console.log(
                `[RESUME] Created thread ${thread.id} for session ${sessionId}`,
              )

              // Fetch all messages for the session
              const messagesResponse = await client.session.messages({
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
                    (p) => p.type === 'text',
                  )
                  const userText = userParts.map((p) => p.text).join('\n\n')
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
              console.error('[RESUME] Error:', error)
              await command.editReply(
                `Failed to resume session: ${error instanceof Error ? error.message : 'Unknown error'}`,
              )
            }
          }
        }
      } catch (error) {
        console.error('[INTERACTION] Error handling interaction:', error)
      }
    },
  )

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
        console.log(
          `[VOICE] Admin user ${member.user.tag} left voice channel: ${oldState.channel?.name}`,
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
            console.log(
              `[VOICE] No other admins in channel, bot leaving voice channel in guild: ${guild.name}`,
            )
            // Stop GenAI session if exists
            if (voiceData.genAiSession) {
              voiceData.genAiSession.stop()
            }
            voiceData.connection.destroy()
            voiceConnections.delete(guildId)
          } else {
            console.log(
              `[VOICE] Other admins still in channel, bot staying in voice channel`,
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
        console.log(
          `[VOICE] Admin user ${member.user.tag} moved from ${oldState.channel?.name} to ${newState.channel?.name}`,
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
              console.log(
                `[VOICE] Following admin to new channel: ${newState.channel?.name}`,
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
              console.log(
                `[VOICE] Other admins still in old channel, bot staying put`,
              )
            }
          }
        }
      }

      // Handle admin joining voice channel (initial join)
      if (oldState.channelId === null && newState.channelId !== null) {
        console.log(
          `[VOICE] Admin user ${member.user.tag} (Owner: ${isOwner}, Admin: ${isAdmin}) joined voice channel: ${newState.channel?.name}`,
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
        console.log(
          `[VOICE] Bot already connected to a voice channel in guild ${newState.guild.name}`,
        )

        // If bot is in a different channel, move to the admin's channel
        if (
          existingVoiceData.connection.joinConfig.channelId !== voiceChannel.id
        ) {
          console.log(
            `[VOICE] Moving bot from channel ${existingVoiceData.connection.joinConfig.channelId} to ${voiceChannel.id}`,
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
        console.log(
          `[VOICE] Attempting to join voice channel: ${voiceChannel.name} (${voiceChannel.id})`,
        )

        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: newState.guild.id,
          adapterCreator: newState.guild.voiceAdapterCreator,
          selfDeaf: false,
          debug: true,

          selfMute: false, // Not muted so bot can speak
        })

        // Store the connection
        voiceConnections.set(newState.guild.id, { connection })

        // Wait for connection to be ready
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000)
        console.log(
          `[VOICE] Successfully joined voice channel: ${voiceChannel.name} in guild: ${newState.guild.name}`,
        )

        // Set up audio processing with GenAI
        const voiceData = voiceConnections.get(newState.guild.id)!

        // Create resampler to convert 16kHz mono to 48kHz stereo
        const resampler = new Resampler({
          inRate: 16000, // GenAI outputs 16kHz
          outRate: 48000, // Discord expects 48kHz
          inChannels: 1, // GenAI outputs mono
          outChannels: 1, // Discord expects stereo
        })


        // Create audio player and resource
        const player = createAudioPlayer()
        const resource = createAudioResource(resampler, {
          inputType: StreamType.Raw,
        })
        player.play(resource)
        connection.subscribe(player)

        // Start GenAI session
        const { session, stop } = await startGenAiSession({
          onAssistantAudioChunk({ data }) {
            console.log(`[VOICE] GenAI audio chunk: ${data.length} bytes`)
            // data is raw PCM s16le @ 16 kHz mono
            // Write to resampler which will convert to 48kHz stereo
            resampler.write(data)
          },
          systemMessage: `You are Kimaki, a helpful AI assistant in a Discord voice channel. You're listening to users speak and will respond with voice. Be conversational and helpful. Keep responses concise.`,
        })

        voiceData.genAiSession = { session, stop }

        // Set up voice receiver for user input
        const receiver = connection.receiver
        receiver.speaking.on('start', (userId) => {
          console.log(`[VOICE] User ${userId} started speaking`)

          const audioStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
          })

          const decoder = new prism.opus.Decoder({
            rate: 48000,
            channels: 2,
            frameSize: 960,
          })

          // Downsample 48k stereo -> 16k mono
          const resampler = new Resampler({
            inRate: 48000,
            outRate: 16000,
            inChannels: 2,
            outChannels: 1,
          })

          // Frame to exact 20 ms blocks so the GenAI side can decode smoothly
          const framer = frame16kMono20ms()

          audioStream
            .once('error', (e) => console.error('[VOICE] opus stream error', e))
            .pipe(decoder)
            .once('error', (e) => console.error('[VOICE] decoder error', e))
            .pipe(resampler)
            .once('error', (e) => console.error('[VOICE] resampler error', e))
            .pipe(framer)
            .on('data', (frame: Buffer) => {
              console.log(
                `[VOICE] sending discord user audio data to genai with length ${frame.length}`,
              )
              if (!voiceData.genAiSession?.session) {
                console.log(
                  `[VOICE] No active GenAI session, cannot send audio input`,
                )
                return
              }
              // stream incrementally — low latency
              voiceData.genAiSession.session.sendRealtimeInput({
                audio: {
                  mimeType: 'audio/pcm;rate=16000',
                  data: frame.toString('base64'),
                },
              })
            })
            .on('end', () => {
              console.log(`[VOICE] User ${userId} stopped speaking`)
              // speaking segment ended after ~1s silence
              // you can signal end-of-utterance if your API needs it
              // voiceData.genAiSession.session?.sendRealtimeInput({ event: 'segment_end' });
            })
        })

        // Handle connection state changes
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
          console.log(
            `[VOICE] Disconnected from voice channel in guild: ${newState.guild.name}`,
          )
          try {
            // Try to reconnect
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ])
            console.log(`[VOICE] Reconnecting to voice channel`)
          } catch (error) {
            // Seems to be a real disconnect, destroy the connection
            console.log(`[VOICE] Failed to reconnect, destroying connection`)
            connection.destroy()
            voiceConnections.delete(newState.guild.id)
          }
        })

        connection.on(VoiceConnectionStatus.Destroyed, () => {
          console.log(
            `[VOICE] Connection destroyed for guild: ${newState.guild.name}`,
          )
          voiceConnections.delete(newState.guild.id)
        })

        // Handle errors
        connection.on('error', (error) => {
          console.error(
            `[VOICE] Connection error in guild ${newState.guild.name}:`,
            error,
          )
        })
      } catch (error) {
        console.error(`[VOICE] Failed to join voice channel:`, error)
        voiceConnections.delete(newState.guild.id)
      }
    } catch (error) {
      console.error('[VOICE] Error in voice state update handler:', error)
    }
  })

  await discordClient.login(token)

  process.on('SIGINT', () => {
    // Kill all OpenCode servers
    for (const [dir, server] of opencodeServers) {
      if (!server.process.killed) {
        console.log(
          `Stopping OpenCode server on port ${server.port} for ${dir}`,
        )
        server.process.kill('SIGTERM')
      }
    }
    // Destroy all voice connections
    for (const [guildId, voiceData] of voiceConnections) {
      if (voiceData.genAiSession) {
        voiceData.genAiSession.stop()
      }
      if (
        voiceData.connection.state.status !== VoiceConnectionStatus.Destroyed
      ) {
        console.log(`Destroying voice connection for guild ${guildId}`)
        voiceData.connection.destroy()
      }
    }
    voiceConnections.clear()
    getDatabase().close()
    discordClient.destroy()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    // Kill all OpenCode servers
    for (const [dir, server] of opencodeServers) {
      if (!server.process.killed) {
        console.log(
          `Stopping OpenCode server on port ${server.port} for ${dir}`,
        )
        server.process.kill('SIGTERM')
      }
    }
    // Destroy all voice connections
    for (const [guildId, voiceData] of voiceConnections) {
      if (voiceData.genAiSession) {
        voiceData.genAiSession.stop()
      }
      if (
        voiceData.connection.state.status !== VoiceConnectionStatus.Destroyed
      ) {
        console.log(`Destroying voice connection for guild ${guildId}`)
        voiceData.connection.destroy()
      }
    }
    voiceConnections.clear()
    getDatabase().close()
    discordClient.destroy()
    process.exit(0)
  })
}
