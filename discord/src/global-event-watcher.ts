/**
 * GlobalEventWatcher - Persistent SSE subscription for Discord sync
 * 
 * This class maintains a single SSE connection to the OpenCode server
 * and routes events to Discord threads based on session-to-thread mappings.
 */

import {
  createOpencodeClient,
  type OpencodeClient,
  type Part,
} from '@opencode-ai/sdk'
import type { Client as DiscordClient, ThreadChannel, Message } from 'discord.js'
import type Database from 'better-sqlite3'
import prettyMilliseconds from 'pretty-ms'
import { createLogger } from './logger.js'

const watcherLogger = createLogger('WATCHER')

export interface WatcherDependencies {
  getDatabase: () => Database.Database
  getDiscordClient: () => DiscordClient
  sendThreadMessage: (thread: ThreadChannel, content: string) => Promise<Message>
  formatPart: (part: Part) => string
}

interface ThreadSession {
  thread_id: string
  session_id: string
  directory: string
}

interface PartMessage {
  part_id: string
  message_id: string
  thread_id: string
}

export class GlobalEventWatcher {
  private client: OpencodeClient | null = null
  private port: number
  private abortController: AbortController | null = null
  private isRunning = false
  private reconnectTimeout: NodeJS.Timeout | null = null
  private deps: WatcherDependencies

  // Track active typing per thread
  private typingIntervals = new Map<string, NodeJS.Timeout>()
  
  // Track accumulated parts per session
  private sessionParts = new Map<string, Part[]>()

  // Track message roles to distinguish User (TUI) vs Assistant
  private messageRoles = new Map<string, string>()

  // Track last completed assistant message per session to avoid duplicate summaries
  private lastCompletedMessageIds = new Map<string, string>()

  // Cache for model context limits
  private modelLimits = new Map<string, number>()

  // Cache for threads that failed to fetch (avoid repeated API calls)
  private failedThreads = new Set<string>()

  constructor(port: number, deps: WatcherDependencies) {
    this.port = port
    this.deps = deps
  }

  /**
   * Start the watcher - subscribe to SSE and process events
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      watcherLogger.log('Watcher already running')
      return
    }

    this.isRunning = true
    watcherLogger.log(`Starting GlobalEventWatcher on port ${this.port}`)

    // Create client
    this.client = createOpencodeClient({
      baseUrl: `http://localhost:${this.port}`,
      fetch: (request: Request) =>
        fetch(request, {
          // @ts-ignore
          timeout: false,
        }),
    })

    // Fetch model limits in background
    this.fetchModelLimits().catch(() => {})

    // Start SSE subscription loop immediately (don't wait for backfill)
    this.subscribeLoop()

    // Run backfill in background
    this.backfillMissedEvents().catch(e => {
      watcherLogger.error('Backfill failed:', e)
    })
  }

  /**
   * Stop the watcher
   */
  stop(): void {
    watcherLogger.log('Stopping GlobalEventWatcher')
    this.isRunning = false
    
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    // Clear all typing indicators
    for (const [threadId, interval] of this.typingIntervals) {
      clearInterval(interval)
    }
    this.typingIntervals.clear()
  }

  /**
   * Fetch model context limits from the server
   */
  private async fetchModelLimits(): Promise<void> {
    try {
      const response = await fetch(`http://localhost:${this.port}/provider`)
      if (!response.ok) return
      const data = await response.json() as any
      if (data.all && Array.isArray(data.all)) {
        for (const provider of data.all) {
          if (provider.models) {
            for (const [id, model] of Object.entries(provider.models)) {
              const limit = (model as any).limit?.context
              if (limit) this.modelLimits.set(id, limit)
            }
          }
        }
        watcherLogger.log(`Loaded context limits for ${this.modelLimits.size} models`)
      }
    } catch (e) {
      watcherLogger.error('Failed to fetch model limits:', e)
    }
  }

  /**
   * Get all linked sessions from the database
   */
  private getLinkedSessions(): ThreadSession[] {
    const db = this.deps.getDatabase()
    const rows = db.prepare(`
      SELECT ts.thread_id, ts.session_id, td.directory
      FROM thread_sessions ts
      LEFT JOIN thread_directories td ON ts.thread_id = td.thread_id
    `).all() as ThreadSession[]
    return rows
  }

  /**
   * Get thread for a session ID
   */
  private getThreadForSession(sessionId: string): string | null {
    const db = this.deps.getDatabase()
    // If a session is linked to multiple threads (e.g. reused/resumed),
    // pick the most recently created thread.
    const row = db.prepare(
      'SELECT thread_id FROM thread_sessions WHERE session_id = ? ORDER BY created_at DESC'
    ).get(sessionId) as { thread_id: string } | undefined
    return row?.thread_id ?? null
  }

  /**
   * Check if a part has already been sent
   */
  private isPartSent(partId: string): boolean {
    const db = this.deps.getDatabase()
    const row = db.prepare(
      'SELECT 1 FROM part_messages WHERE part_id = ?'
    ).get(partId)
    return !!row
  }

  /**
   * Record that a part was sent
   */
  private recordPartSent(partId: string, messageId: string, threadId: string): void {
    const db = this.deps.getDatabase()
    db.prepare(
      'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)'
    ).run(partId, messageId, threadId)
  }

  /**
   * Backfill missed events for all linked sessions
   */
  private async backfillMissedEvents(): Promise<void> {
    if (!this.client) return

    const sessions = this.getLinkedSessions()
    watcherLogger.log(`Backfilling ${sessions.length} linked sessions`)

    for (const session of sessions) {
      try {
        await this.backfillSession(session.session_id, session.thread_id)
      } catch (e) {
        watcherLogger.error(`Failed to backfill session ${session.session_id}:`, e)
      }
    }
    
    watcherLogger.log(`Backfill completed for ${sessions.length} sessions`)
  }

  /**
   * Backfill a single session
   */
  private async backfillSession(sessionId: string, threadId: string): Promise<void> {
    if (!this.client) return

    const messagesResponse = await this.client.session.messages({
      path: { id: sessionId },
    })

    if (!messagesResponse.data) {
      watcherLogger.log(`No messages found for session ${sessionId}`)
      return
    }

    const messages = messagesResponse.data
    let backfilledCount = 0

    for (const message of messages) {
      if (message.info.role !== 'assistant') continue

      for (const part of message.parts) {
        if (this.isPartSent(part.id)) continue
        if (part.type === 'step-start' || part.type === 'step-finish') continue

        // This part was missed - send it now
        const thread = await this.getThread(threadId)
        if (!thread) continue

        const content = this.deps.formatPart(part)
        // Ensure content is a string and not empty
        if (typeof content !== 'string' || !content.trim()) continue

        try {
          const discordMessage = await this.deps.sendThreadMessage(thread, content + '\n\n')
          this.recordPartSent(part.id, discordMessage.id, threadId)
          backfilledCount++
        } catch (e) {
          watcherLogger.error(`Failed to backfill part ${part.id}:`, e)
        }
      }
    }

    if (backfilledCount > 0) {
      watcherLogger.log(`Backfilled ${backfilledCount} parts for session ${sessionId}`)
    }
  }

  /**
   * Get Discord thread channel
   */
  private async getThread(threadId: string): Promise<ThreadChannel | null> {
    // Skip if we already know this thread doesn't exist
    if (this.failedThreads.has(threadId)) {
      return null
    }

    try {
      const channel = await this.deps.getDiscordClient().channels.fetch(threadId)
      if (channel?.isThread()) {
        return channel as ThreadChannel
      }
    } catch (e) {
      // Cache the failure to avoid repeated API calls
      this.failedThreads.add(threadId)
      watcherLogger.log(`Thread ${threadId} not found, marking as unavailable`)
    }
    return null
  }

  /**
   * Start typing indicator for a thread
   */
  private startTyping(threadId: string, thread: ThreadChannel): void {
    // Clear any existing interval
    this.stopTyping(threadId)

    // Send initial typing
    thread.sendTyping().catch(() => {})

    // Set up interval
    const interval = setInterval(() => {
      thread.sendTyping().catch(() => {})
    }, 8000)

    this.typingIntervals.set(threadId, interval)
  }

  /**
   * Stop typing indicator for a thread
   */
  private stopTyping(threadId: string): void {
    const interval = this.typingIntervals.get(threadId)
    if (interval) {
      clearInterval(interval)
      this.typingIntervals.delete(threadId)
    }
  }

  /**
   * Main SSE subscription loop with reconnection
   */
  private async subscribeLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.subscribe()
      } catch (e) {
        if (!this.isRunning) break
        watcherLogger.error('SSE subscription error:', e)
      }

      if (!this.isRunning) break

      // Wait before reconnecting
      watcherLogger.log('Reconnecting in 5 seconds...')
      await new Promise(resolve => {
        this.reconnectTimeout = setTimeout(resolve, 5000)
      })
    }
  }

  /**
   * Subscribe to SSE events
   */
  private async subscribe(): Promise<void> {
    if (!this.client) return

    this.abortController = new AbortController()

    watcherLogger.log('Subscribing to SSE events...')
    const eventsResult = await this.client.event.subscribe({
      signal: this.abortController.signal,
    })

    const events = eventsResult.stream
    watcherLogger.log('SSE subscription established')

    for await (const event of events) {
      if (!this.isRunning) break
      await this.handleEvent(event)
    }
  }

  /**
   * Handle an SSE event
   */
  private async handleEvent(event: any): Promise<void> {
    const sessionId = event.properties?.info?.sessionID 
      || event.properties?.part?.sessionID
      || event.properties?.sessionID

    if (!sessionId) return

    // Check if this session is linked to a Discord thread
    const threadId = this.getThreadForSession(sessionId)
    if (!threadId) return

    const thread = await this.getThread(threadId)
    if (!thread) return

    if (event.type === 'message.updated') {
      const msg = event.properties.info
      if (msg && msg.id && msg.role) {
        this.messageRoles.set(msg.id, msg.role)
        
        // Handle assistant message completion summary when message finishes with 'stop'
        // 'stop' means the agent finished responding, 'tool-calls' means it's doing tools
        if (msg.role === 'assistant' && msg.finish === 'stop') {
          const lastId = this.lastCompletedMessageIds.get(sessionId)
          if (lastId !== msg.id) {
            this.lastCompletedMessageIds.set(sessionId, msg.id)
            await this.sendCompletionSummary(thread, msg)
          }
        }
      }
    } else if (event.type === 'message.part.updated') {
      const part = event.properties.part as Part
      const role = this.messageRoles.get(part.messageID) || 'assistant'

      // Handle User messages (TUI prompts) immediately
      if (role === 'user' && part.type === 'text') {
        await this.sendPart(part, thread, threadId, role)
        return
      }

      // Get or create parts array for this session (Assistant only)
      let parts = this.sessionParts.get(sessionId)
      if (!parts) {
        parts = []
        this.sessionParts.set(sessionId, parts)
      }

      // Update or add part
      const existingIndex = parts.findIndex(p => p.id === part.id)
      if (existingIndex >= 0) {
        parts[existingIndex] = part
      } else {
        parts.push(part)
      }

      // Handle typing on step-start
      if (part.type === 'step-start') {
        this.startTyping(threadId, thread)
      }

      // Send tool parts immediately when running
      if (part.type === 'tool' && part.state.status === 'running') {
        await this.sendPart(part, thread, threadId, role)
      }

      // Send reasoning parts immediately
      if (part.type === 'reasoning') {
        await this.sendPart(part, thread, threadId, role)
      }

      // On step-finish, send all accumulated parts
      if (part.type === 'step-finish') {
        this.stopTyping(threadId)
        
        for (const p of parts) {
          if (p.type !== 'step-start' && p.type !== 'step-finish') {
            await this.sendPart(p, thread, threadId, role)
          }
        }

        // Clear accumulated parts after sending
        this.sessionParts.delete(sessionId)
      }
    } else if (event.type === 'session.completed') {
      this.stopTyping(threadId)
      this.sessionParts.delete(sessionId)
    } else if (event.type === 'session.error') {
      this.stopTyping(threadId)
      const errorMessage = event.properties?.error?.data?.message || 'Unknown error'
      await this.deps.sendThreadMessage(thread, `**Error:** ${errorMessage}`)
    }
  }

  /**
   * Send completion summary
   */
  private async sendCompletionSummary(thread: ThreadChannel, msg: any) {
    const tokens = msg.tokens || {}
    const info = msg
    
    let summaryParts: string[] = []

    if (tokens) {
      const input = (tokens.input || 0)
      const output = (tokens.output || 0)
      const reasoning = (tokens.reasoning || 0)
      const cacheRead = (tokens.cache?.read || 0)
      const total = input + output + reasoning
      
      if (total > 0) {
        let tokensStr = `Tokens: ${total.toLocaleString()}`
        
        // Calculate percentage
        const limit = this.modelLimits.get(info.modelID)
        if (limit) {
          const usage = input + cacheRead
          const percent = ((usage / limit) * 100).toFixed(1)
          tokensStr += ` (${percent}%)`
        }
        
        summaryParts.push(tokensStr)
      }
      
    }

    // Calculate duration if we have timing info
    if (info.time?.created && info.time?.completed) {
      const duration = info.time.completed - info.time.created
      if (duration > 0) {
         summaryParts.push(`Time: ${prettyMilliseconds(duration)}`)
      }
    }

    if (info.modelID) {
      summaryParts.push(`Model: ${info.modelID}`)
    }

    if (summaryParts.length > 0) {
      await this.deps.sendThreadMessage(thread, `-# Completed. ${summaryParts.join(' • ')}`)
    }
  }

  /**
   * Send a part to Discord (with deduplication)
   */
  private async sendPart(part: Part, thread: ThreadChannel, threadId: string, role: string = 'assistant'): Promise<void> {
    if (this.isPartSent(part.id)) return

    let content = this.deps.formatPart(part)
    
    // User message echo prevention and formatting
    if (role === 'user' && part.type === 'text') {
      // Fetch recent messages to check for echo
      const lastMessages = await thread.messages.fetch({ limit: 10 }).catch(() => null)
      
      // Find a recent message from a non-bot user that matches the content
      // This handles cases where attachments are appended to the prompt
      const partText = (part.text || '').trim()
      
      // Also check the thread starter message (it may have different format)
      const starterMessage = thread.id ? await thread.fetchStarterMessage().catch(() => null) : null
      
      const recentUserMessage = lastMessages?.find(msg => {
        // Must be from a non-bot user
        if (msg.author.bot) return false
        // Must be recent (within last 2 minutes)
        const age = Date.now() - msg.createdTimestamp
        if (age > 120000) return false
        // Content should match or be a prefix of the part text (attachments get appended)
        const msgContent = msg.content.trim()
        // Check both directions: Discord content is prefix of part, or exact match
        return partText === msgContent || partText.startsWith(msgContent) || msgContent.startsWith(partText)
      })
      
      // Also check starter message
      const starterMatch = starterMessage && !starterMessage.author.bot && (
        partText === starterMessage.content.trim() ||
        partText.startsWith(starterMessage.content.trim()) ||
        starterMessage.content.trim().startsWith(partText)
      )
      
      if (recentUserMessage || starterMatch) {
        // Echo detected - message originated from Discord, not TUI
        const matchedMsg = recentUserMessage || starterMessage!
        this.recordPartSent(part.id, matchedMsg.id, threadId)
        return
      }

      // Not an echo (TUI message), quote it
      content = `-# 📝 _Prompt from TUI:_\n> ${content.split('\n').join('\n> ')}`
    }

    // Ensure content is a string and not empty
    if (typeof content !== 'string' || !content.trim()) return

    try {
      const message = await this.deps.sendThreadMessage(thread, content + '\n\n')
      this.recordPartSent(part.id, message.id, threadId)
    } catch (e) {
      watcherLogger.error(`Failed to send part ${part.id}:`, e)
    }
  }
}
