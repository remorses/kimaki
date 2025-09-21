import path from 'node:path'
import fs from 'node:fs'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ThreadAutoArchiveDuration,
  type Message,
  type ThreadChannel,
  type Guild,
  type TextChannel,
} from 'discord.js'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import {
  createOpencodeClient,
  type OpencodeClient,
  type Part,
} from '@opencode-ai/sdk'
import dedent from 'string-dedent'
import { Database } from 'bun:sqlite'
import { extractTagsArrays } from './xml'
import { transcribeAudio } from './voice'
import { $ } from 'bun'
import { Lexer } from 'marked'

type StartOptions = {
  token: string
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

let db: Database | null = null

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
}: {
  message: Message
  thread: ThreadChannel
  projectDirectory?: string
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
        console.log(`[VOICE MESSAGE] Getting project file tree from ${projectDirectory}`)
        // Use git ls-files to get tracked files, then pipe to tree
        const result = await $`cd ${projectDirectory} && git ls-files | tree --fromfile -a`.text()

        if (result) {
          transcriptionPrompt = `Discord voice message transcription. Project file structure:\n${result}\n\nPlease transcribe file names and paths accurately based on this context.`
          console.log(`[VOICE MESSAGE] Added project context to transcription prompt`)
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

    // Update thread name with transcribed content
    const threadName = transcription.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (threadName) {
      try {
        await Promise.race([
          thread.setName(threadName),
          new Promise((resolve) => setTimeout(resolve, 2000))
        ])
        console.log(`[THREAD] Updated thread name to: "${threadName}"`)
      } catch (e) {
        console.log(`[THREAD] Could not update thread name:`, e)
      }
    }

    await sendThreadMessage(
      thread,
      `📝 **Transcribed message:** ${transcription}`,
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

export async function initializeOpencodeForDirectory(
  directory: string,
): Promise<OpencodeClient> {
  console.log(`[OPENCODE] Initializing for directory: ${directory}`)

  // Check if we already have a server for this directory
  const existing = opencodeServers.get(directory)
  if (existing && !existing.process.killed) {
    console.log(
      `[OPENCODE] Reusing existing server on port ${existing.port} for directory: ${directory}`,
    )
    return existing.client
  }

  const port = await getOpenPort()
  console.log(
    `[OPENCODE] Starting new server on port ${port} for directory: ${directory}`,
  )

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
      return part.text || ''
    case 'reasoning':
      return `💭 ${part.text || ''}`
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
        outputToDisplay = outputToDisplay.replace(/```/g, '\\`\\`\\`')

        let toolTitle =
          part.state.status === 'completed' ? part.state.title || '' : 'error'
        if (toolTitle) toolTitle = `\`${toolTitle}\``
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
            text += '\n' + outputToDisplay
          } else {
            text += dedent`
            \`\`\`${language}
            ${outputToDisplay}
            \`\`\`
            `
          }
        }
        return text
      }
      return ''
    case 'file':
      return `📄 ${part.filename || 'File'}`
    case 'step-start':
    case 'step-finish':
      return ''
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
  getDatabase().prepare(
    'INSERT OR REPLACE INTO thread_sessions (thread_id, session_id) VALUES (?, ?)',
  ).run(thread.id, session.id)
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
      getDatabase().prepare(
        'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)',
      ).run(part.id, firstMessage.id, thread.id)
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
            }, 100)
          }
        } else if (event.type === 'session.error') {
          console.error(`[SESSION ERROR]`, event.properties)
          if (event.properties.sessionID === session.id) {
            const errorData = event.properties.error
            const errorMessage = errorData?.data?.message || 'Unknown error'
            console.error(
              `[SESSION ERROR] Sending error to thread: ${errorMessage}`,
            )
            await sendThreadMessage(thread, `✗ Error: ${errorMessage}`)

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
        `✗ Error: ${error instanceof Error ? error.message : String(error)}`,
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
  otherTags: Record<string, string[]>
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
      let otherTags: Record<string, string[]> = {}

      if (description) {
        const extracted = extractTagsArrays({
          xml: description,
          tags: ['kimaki.directory'],
        })

        kimakiDirectory = extracted['kimaki.directory']?.[0]?.trim()

        // Store any other extracted tags
        const extractedKeys = Object.keys(
          extracted,
        ) as (keyof typeof extracted)[]
        extractedKeys.forEach((key) => {
          if (key !== 'kimaki.directory' && key !== 'others') {
            otherTags[key] = extracted[key]
          }
        })
      }

      channels.push({
        id: textChannel.id,
        name: textChannel.name,
        description,
        kimakiDirectory,
        otherTags,
      })
    })

  return channels
}

export async function startDiscordBot({ token, discordClient }: StartOptions & { discordClient?: Client }) {
  if (!discordClient) {
    discordClient = await createDiscordClient()
  }

  discordClient.once(Events.ClientReady, async (c) => {
    console.log(`[READY] Discord bot logged in as ${c.user.tag}`)
    console.log(`[READY] Connected to ${c.guilds.cache.size} guild(s)`)

    // List all guilds and channels with kimaki.directory tags
    for (const guild of c.guilds.cache.values()) {
      console.log(`[GUILD] ${guild.name} (${guild.id})`)

      const channels = await getChannelsWithDescriptions(guild)
      const kimakiChannels = channels.filter((ch) => ch.kimakiDirectory)

      if (kimakiChannels.length > 0) {
        console.log(
          `  Found ${kimakiChannels.length} channel(s) with kimaki.directory:`,
        )
        for (const channel of kimakiChannels) {
          console.log(`  - #${channel.name}: ${channel.kimakiDirectory}`)
        }
      } else {
        console.log(`  No channels with kimaki.directory tag`)
      }
    }

    console.log(
      `[READY] Bot is ready and monitoring all channels with kimaki.directory tags`,
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

        // Get project directory from parent channel
        const parent = thread.parent as TextChannel | null
        const projectDirectory = parent?.topic
          ? extractTagsArrays({
              xml: parent.topic,
              tags: ['kimaki.directory'],
            })['kimaki.directory']?.[0]?.trim()
          : undefined

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

        const projectDirectory = extractTagsArrays({
          xml: textChannel.topic,
          tags: ['kimaki.directory'],
        })['kimaki.directory']?.[0]?.trim()

        if (!projectDirectory) {
          console.log(
            `[IGNORED] Channel #${textChannel.name} has no kimaki.directory tag`,
          )
          return
        }

        console.log(`[DIRECTORY] Found kimaki.directory: ${projectDirectory}`)

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
    getDatabase().close()
    discordClient.destroy()
    process.exit(0)
  })
}
