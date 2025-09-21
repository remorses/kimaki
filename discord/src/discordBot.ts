import path from 'node:path'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
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
import { $ } from 'bun'

type StartOptions = {
  token: string
  channelId: string
}

let serverProcess: ChildProcess | null = null
let client: OpencodeClient | null = null

const db = new Database(':memory:')

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

async function initializeOpencode() {
  if (!serverProcess || serverProcess.killed) {
    const port = await getOpenPort()
    console.log(`Starting OpenCode server on port ${port}...`)

    serverProcess = spawn('opencode', ['serve', '--port', port.toString()], {
      stdio: 'pipe',
      detached: false,
      env: {
        ...process.env,
        OPENCODE_PORT: port.toString(),
      },
    })

    serverProcess.stdout?.on('data', (data) => {
      console.log(`[OpenCode] ${data.toString().trim()}`)
    })

    serverProcess.stderr?.on('data', (data) => {
      console.error(`[OpenCode Error] ${data.toString().trim()}`)
    })

    serverProcess.on('error', (error) => {
      console.error('Failed to start OpenCode server:', error)
    })
    serverProcess.on('exit', (error) => {
      console.error('OpenCode server exited:', error)
    })

    await waitForServer(port)
    client = createOpencodeClient({ baseUrl: `http://localhost:${port}` })
  }

  return client!
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
              let statusIcon = '[ ]'
              switch (todo.status) {
                case 'pending':
                  statusIcon = '[ ]'
                  break
                case 'in_progress':
                  statusIcon = '[~]'
                  break
                case 'completed':
                  statusIcon = '[x]'
                  break
                case 'cancelled':
                  statusIcon = '[!]'
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
          text += dedent`
          \`\`\`${language}
          ${outputToDisplay}
          \`\`\`
          `
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

async function handleOpencodeSession(prompt: string, thread: ThreadChannel) {
  const client = await initializeOpencode()

  // Get session ID from database
  const row = db
    .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
    .get(thread.id) as { session_id: string } | undefined
  let sessionId = row?.session_id
  let session

  if (sessionId) {
    try {
      const sessionResponse = await client.session.get({
        path: { id: sessionId },
      })
      session = sessionResponse.data
    } catch (error) {
      console.log('Session not found, creating new one')
    }
  }

  if (!session) {
    const sessionResponse = await client.session.create({
      body: { title: prompt.slice(0, 80) },
    })
    session = sessionResponse.data
  }

  if (!session) {
    throw new Error('Failed to create or get session')
  }

  // Store session ID in database
  db.prepare(
    'INSERT OR REPLACE INTO thread_sessions (thread_id, session_id) VALUES (?, ?)',
  ).run(thread.id, session.id)

  const eventsResult = await client.event.subscribe()
  const events = eventsResult.stream

  // Load existing part-message mappings from database
  const partIdToMessage = new Map<string, Message>()
  const existingParts = db
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

  const sendPartMessage = async (part: Part) => {
    const content = formatPart(part) + '\n\n'
    if (!content || content.length === 0) return

    // Skip if already sent
    if (partIdToMessage.has(part.id)) return

    try {
      const newMessage = await thread.send(content.slice(0, 6000))
      partIdToMessage.set(part.id, newMessage)

      // Store part-message mapping in database
      db.prepare(
        'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)',
      ).run(part.id, newMessage.id, thread.id)
    } catch (error) {
      console.error('Failed to send message:', error)
    }
  }

  const eventHandler = (async () => {
    try {
      let assistantMessageId: string | undefined

      for await (const event of events) {
        console.log(event.type)
        if (event.type === 'message.updated') {
          const msg = event.properties.info

          if (msg.sessionID !== session.id) {
            console.log(`ignoring message from another session`, msg)
            continue
          }

          // Track assistant message ID
          if (msg.role === 'assistant') {
            assistantMessageId = msg.id
          }
        } else if (event.type === 'message.part.updated') {
          const part = event.properties.part

          if (part.sessionID !== session.id) {
            console.log(`ignoring different session part`, part)
            continue
          }

          // Only process parts from assistant messages
          if (part.messageID !== assistantMessageId) {
            console.log(`ignoring non assistant part`, part)
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
            `Part update: id=${part.id}, type=${part.type}, text=${'text' in part && typeof part.text === 'string' ? part.text.slice(0, 50) : ''}`,
          )

          // Check if this is a step-finish part
          if (part.type === 'step-finish') {
            // Send all parts accumulated so far to Discord
            console.log('Step finished, sending parts to Discord')
            for (const p of currentParts) {
              // Skip step-start and step-finish parts as they have no visual content
              if (p.type !== 'step-start' && p.type !== 'step-finish') {
                await sendPartMessage(p)
              }
            }
          }
        } else if (event.type === 'session.error') {
          console.error('session error', event.properties)
          if (event.properties.sessionID === session.id) {
            const errorData = event.properties.error
            const errorMessage = errorData?.data?.message || 'Unknown error'
            await thread.send(`❌ Error: ${errorMessage}`)
          }
          break
        } else if (event.type === 'file.edited') {
        }
      }
    } catch (e) {
      console.error(`unexpected error in event handling code`, e)
      throw e
    } finally {
      // Send any remaining parts that weren't sent
      for (const part of currentParts) {
        if (!partIdToMessage.has(part.id)) {
          console.log(
            `Final update for part without message: id=${part.id}, type=${part.type}`,
          )
          await sendPartMessage(part)
        }
      }
    }
  })()

  try {
    const response = await client.session.prompt({
      path: { id: session.id },
      body: {
        parts: [{ type: 'text', text: prompt }],
      },
    })

    return { sessionID: session.id, result: response.data }
  } catch (error) {
    await thread.send(
      `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
}

export type ChannelWithTags = {
  id: string
  name: string
  description: string | null
  kimakiRepoUrl?: string
  kimakiBranch?: string
  otherTags: Record<string, string[]>
}

export type OpencodeProject = {
  id: string
  directory: string
  repoUrl?: string
  branch?: string
}

export async function getOpencodeProjects(): Promise<OpencodeProject[]> {
  const client = await initializeOpencode()
  const projects: OpencodeProject[] = []

  const projectsResponse = await client.project.list()
  if (!projectsResponse.data) {
    return projects
  }

  for (const project of projectsResponse.data) {
    const projectInfo: OpencodeProject = {
      id: project.id,
      directory: project.worktree,
    }

    // Get git info if it's a git repo
    if (project.vcs === 'git') {
      try {
        // Get current branch
        const branchResult = await $`git branch --show-current`
          .cwd(project.worktree)
          .quiet()
        const branch = branchResult.text().trim()
        if (branch) {
          projectInfo.branch = branch
        }

        // Get origin remote URL
        const urlResult = await $`git remote get-url origin`
          .cwd(project.worktree)
          .quiet()
        const url = urlResult.text().trim()
        if (url) {
          projectInfo.repoUrl = url
        }
      } catch {
        // Git info not available
      }
    }

    projects.push(projectInfo)
  }

  return projects
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

      let kimakiRepoUrl: string | undefined
      let kimakiBranch: string | undefined
      let otherTags: Record<string, string[]> = {}

      if (description) {
        const extracted = extractTagsArrays({
          xml: description,
          tags: ['kimaki.repoUrl', 'kimaki.branch'],
        })

        kimakiRepoUrl = extracted['kimaki.repoUrl']?.[0]
        kimakiBranch = extracted['kimaki.branch']?.[0]

        // Store any other extracted tags
        const extractedKeys = Object.keys(
          extracted,
        ) as (keyof typeof extracted)[]
        extractedKeys.forEach((key) => {
          if (
            key !== 'kimaki.repoUrl' &&
            key !== 'kimaki.branch' &&
            key !== 'others'
          ) {
            otherTags[key] = extracted[key]
          }
        })
      }

      channels.push({
        id: textChannel.id,
        name: textChannel.name,
        description,
        kimakiRepoUrl,
        kimakiBranch,
        otherTags,
      })
    })

  return channels
}

export async function startDiscordBot({ token, channelId }: StartOptions) {
  const discordClient = new Client({
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

  discordClient.once(Events.ClientReady, (c) => {
    console.log(`Discord bot logged in as ${c.user.tag}`)
  })

  discordClient.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author?.bot) return
      if (message.partial) {
        try {
          await message.fetch()
        } catch {
          return
        }
      }

      if (message.channelId === channelId) {
        const baseName = message.content.replace(/\s+/g, ' ').trim()
        const name = (baseName || 'Claude Thread').slice(0, 80)

        const thread = await message.startThread({
          name: name.length > 0 ? name : 'Claude Thread',
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: 'Start Claude session',
        })

        // await thread.send('thinking…')
        await handleOpencodeSession(message.content || '', thread)
        return
      }

      const channel = message.channel
      const isThreadChannel =
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread ||
        channel.type === ChannelType.AnnouncementThread

      if (isThreadChannel) {
        const thread = channel as ThreadChannel
        // Check if thread has an existing session in database
        const row = db
          .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
          .get(thread.id) as { session_id: string } | undefined
        if (!row) return

        const thinkingMessage = await thread.send('Thinking…')
        await handleOpencodeSession(message.content || '', thread)
        await thinkingMessage.delete()
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
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM')
    }
    db.close()
    discordClient.destroy()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM')
    }
    db.close()
    discordClient.destroy()
    process.exit(0)
  })
}
