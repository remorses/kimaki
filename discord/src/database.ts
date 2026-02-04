// SQLite database manager for persistent bot state using Prisma.
// Stores thread-session mappings, bot tokens, channel directories,
// API keys, and model preferences in <dataDir>/discord-sessions.db.

import { getPrisma, closePrisma } from './db.js'
import { getDefaultVerbosity } from './config.js'
import { createLogger, LogPrefix } from './logger.js'

const dbLogger = createLogger(LogPrefix.DB)

// Re-export Prisma utilities
export { getPrisma, closePrisma }

/**
 * Initialize the database.
 * Returns the Prisma client.
 */
export async function initDatabase() {
    const prisma = await getPrisma()
    dbLogger.log('Database initialized')
    return prisma
}

/**
 * Close the database connection.
 */
export async function closeDatabase() {
    await closePrisma()
}

// Verbosity levels for controlling output detail
// - tools-and-text: shows all output including tool executions
// - text-and-essential-tools: shows text + edits + custom MCP tools, hides read/search/navigation tools
// - text-only: only shows text responses (⬥ diamond parts)
export type VerbosityLevel = 'tools-and-text' | 'text-and-essential-tools' | 'text-only'

// Worktree status types
export type WorktreeStatus = 'pending' | 'ready' | 'error'

export type ThreadWorktree = {
    thread_id: string
    worktree_name: string
    worktree_directory: string | null
    project_directory: string
    status: WorktreeStatus
    error_message: string | null
}

// ============================================================================
// Channel Model Functions
// ============================================================================

/**
 * Get the model preference for a channel.
 * @returns Model ID in format "provider_id/model_id" or undefined
 */
export async function getChannelModel(channelId: string): Promise<string | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.channel_models.findUnique({
        where: { channel_id: channelId },
    })
    return row?.model_id
}

/**
 * Set the model preference for a channel.
 * @param modelId Model ID in format "provider_id/model_id"
 */
export async function setChannelModel(channelId: string, modelId: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.channel_models.upsert({
        where: { channel_id: channelId },
        create: { channel_id: channelId, model_id: modelId },
        update: { model_id: modelId, updated_at: new Date() },
    })
}

// ============================================================================
// Global Model Functions
// ============================================================================

/**
 * Get the global default model for a bot.
 * @returns Model ID in format "provider_id/model_id" or undefined
 */
export async function getGlobalModel(appId: string): Promise<string | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.global_models.findUnique({
        where: { app_id: appId },
    })
    return row?.model_id
}

/**
 * Set the global default model for a bot.
 * @param modelId Model ID in format "provider_id/model_id"
 */
export async function setGlobalModel(appId: string, modelId: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.global_models.upsert({
        where: { app_id: appId },
        create: { app_id: appId, model_id: modelId },
        update: { model_id: modelId, updated_at: new Date() },
    })
}

// ============================================================================
// Session Model Functions
// ============================================================================

/**
 * Get the model preference for a session.
 * @returns Model ID in format "provider_id/model_id" or undefined
 */
export async function getSessionModel(sessionId: string): Promise<string | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.session_models.findUnique({
        where: { session_id: sessionId },
    })
    return row?.model_id
}

/**
 * Set the model preference for a session.
 * @param modelId Model ID in format "provider_id/model_id"
 */
export async function setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.session_models.upsert({
        where: { session_id: sessionId },
        create: { session_id: sessionId, model_id: modelId },
        update: { model_id: modelId },
    })
}

/**
 * Clear the model preference for a session.
 * Used when switching agents so the agent's model takes effect.
 */
export async function clearSessionModel(sessionId: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.session_models.deleteMany({
        where: { session_id: sessionId },
    })
}

// ============================================================================
// Channel Agent Functions
// ============================================================================

/**
 * Get the agent preference for a channel.
 */
export async function getChannelAgent(channelId: string): Promise<string | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.channel_agents.findUnique({
        where: { channel_id: channelId },
    })
    return row?.agent_name
}

/**
 * Set the agent preference for a channel.
 */
export async function setChannelAgent(channelId: string, agentName: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.channel_agents.upsert({
        where: { channel_id: channelId },
        create: { channel_id: channelId, agent_name: agentName },
        update: { agent_name: agentName, updated_at: new Date() },
    })
}

// ============================================================================
// Session Agent Functions
// ============================================================================

/**
 * Get the agent preference for a session.
 */
export async function getSessionAgent(sessionId: string): Promise<string | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.session_agents.findUnique({
        where: { session_id: sessionId },
    })
    return row?.agent_name
}

/**
 * Set the agent preference for a session.
 */
export async function setSessionAgent(sessionId: string, agentName: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.session_agents.upsert({
        where: { session_id: sessionId },
        create: { session_id: sessionId, agent_name: agentName },
        update: { agent_name: agentName },
    })
}

// ============================================================================
// Thread Worktree Functions
// ============================================================================

/**
 * Get the worktree info for a thread.
 */
export async function getThreadWorktree(threadId: string): Promise<ThreadWorktree | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.thread_worktrees.findUnique({
        where: { thread_id: threadId },
    })
    if (!row) {
        return undefined
    }
    return {
        thread_id: row.thread_id,
        worktree_name: row.worktree_name,
        worktree_directory: row.worktree_directory,
        project_directory: row.project_directory,
        status: row.status as WorktreeStatus,
        error_message: row.error_message,
    }
}

/**
 * Create a pending worktree entry for a thread.
 */
export async function createPendingWorktree({
    threadId,
    worktreeName,
    projectDirectory,
}: {
    threadId: string
    worktreeName: string
    projectDirectory: string
}): Promise<void> {
    const prisma = await getPrisma()
    await prisma.thread_worktrees.upsert({
        where: { thread_id: threadId },
        create: {
            thread_id: threadId,
            worktree_name: worktreeName,
            project_directory: projectDirectory,
            status: 'pending',
        },
        update: {
            worktree_name: worktreeName,
            project_directory: projectDirectory,
            status: 'pending',
            worktree_directory: null,
            error_message: null,
        },
    })
}

/**
 * Mark a worktree as ready with its directory.
 */
export async function setWorktreeReady({
    threadId,
    worktreeDirectory,
}: {
    threadId: string
    worktreeDirectory: string
}): Promise<void> {
    const prisma = await getPrisma()
    await prisma.thread_worktrees.update({
        where: { thread_id: threadId },
        data: {
            worktree_directory: worktreeDirectory,
            status: 'ready',
        },
    })
}

/**
 * Mark a worktree as failed with error message.
 */
export async function setWorktreeError({
    threadId,
    errorMessage,
}: {
    threadId: string
    errorMessage: string
}): Promise<void> {
    const prisma = await getPrisma()
    await prisma.thread_worktrees.update({
        where: { thread_id: threadId },
        data: {
            status: 'error',
            error_message: errorMessage,
        },
    })
}

/**
 * Delete the worktree info for a thread.
 */
export async function deleteThreadWorktree(threadId: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.thread_worktrees.deleteMany({
        where: { thread_id: threadId },
    })
}

// ============================================================================
// Channel Verbosity Functions
// ============================================================================

/**
 * Get the verbosity setting for a channel.
 * Falls back to the global default set via --verbosity CLI flag if no per-channel override exists.
 */
export async function getChannelVerbosity(channelId: string): Promise<VerbosityLevel> {
    const prisma = await getPrisma()
    const row = await prisma.channel_verbosity.findUnique({
        where: { channel_id: channelId },
    })
    if (row?.verbosity) {
        return row.verbosity as VerbosityLevel
    }
    return getDefaultVerbosity()
}

/**
 * Set the verbosity setting for a channel.
 */
export async function setChannelVerbosity(channelId: string, verbosity: VerbosityLevel): Promise<void> {
    const prisma = await getPrisma()
    await prisma.channel_verbosity.upsert({
        where: { channel_id: channelId },
        create: { channel_id: channelId, verbosity },
        update: { verbosity, updated_at: new Date() },
    })
}

// ============================================================================
// Channel Worktree Settings Functions
// ============================================================================

/**
 * Check if automatic worktree creation is enabled for a channel.
 */
export async function getChannelWorktreesEnabled(channelId: string): Promise<boolean> {
    const prisma = await getPrisma()
    const row = await prisma.channel_worktrees.findUnique({
        where: { channel_id: channelId },
    })
    return row?.enabled === 1
}

/**
 * Enable or disable automatic worktree creation for a channel.
 */
export async function setChannelWorktreesEnabled(channelId: string, enabled: boolean): Promise<void> {
    const prisma = await getPrisma()
    await prisma.channel_worktrees.upsert({
        where: { channel_id: channelId },
        create: { channel_id: channelId, enabled: enabled ? 1 : 0 },
        update: { enabled: enabled ? 1 : 0, updated_at: new Date() },
    })
}

// ============================================================================
// Channel Directory Functions
// ============================================================================

/**
 * Get the directory and app_id for a channel from the database.
 * This is the single source of truth for channel-project mappings.
 */
export async function getChannelDirectory(channelId: string): Promise<{
    directory: string
    appId: string | null
} | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.channel_directories.findUnique({
        where: { channel_id: channelId },
    })

    if (!row) {
        return undefined
    }

    return {
        directory: row.directory,
        appId: row.app_id,
    }
}

// ============================================================================
// Thread Session Functions
// ============================================================================

/**
 * Get the session ID for a thread.
 */
export async function getThreadSession(threadId: string): Promise<string | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.thread_sessions.findUnique({
        where: { thread_id: threadId },
    })
    return row?.session_id
}

/**
 * Set the session ID for a thread.
 */
export async function setThreadSession(threadId: string, sessionId: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.thread_sessions.upsert({
        where: { thread_id: threadId },
        create: { thread_id: threadId, session_id: sessionId },
        update: { session_id: sessionId },
    })
}

/**
 * Get the thread ID for a session.
 */
export async function getThreadIdBySessionId(sessionId: string): Promise<string | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.thread_sessions.findFirst({
        where: { session_id: sessionId },
    })
    return row?.thread_id
}

/**
 * Get all session IDs that are associated with threads.
 */
export async function getAllThreadSessionIds(): Promise<string[]> {
    const prisma = await getPrisma()
    const rows = await prisma.thread_sessions.findMany({
        select: { session_id: true },
    })
    return rows.map((row) => row.session_id).filter((id) => id !== '')
}

// ============================================================================
// Part Messages Functions
// ============================================================================

/**
 * Get all part IDs for a thread.
 */
export async function getPartMessageIds(threadId: string): Promise<string[]> {
    const prisma = await getPrisma()
    const rows = await prisma.part_messages.findMany({
        where: { thread_id: threadId },
        select: { part_id: true },
    })
    return rows.map((row) => row.part_id)
}

/**
 * Store a part-message mapping.
 * Note: The thread must already have a session (via setThreadSession) before calling this.
 */
export async function setPartMessage(partId: string, messageId: string, threadId: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.part_messages.upsert({
        where: { part_id: partId },
        create: { part_id: partId, message_id: messageId, thread_id: threadId },
        update: { message_id: messageId, thread_id: threadId },
    })
}

/**
 * Store multiple part-message mappings in a transaction.
 * More efficient and atomic for batch operations.
 * Note: The thread must already have a session (via setThreadSession) before calling this.
 */
export async function setPartMessagesBatch(
    partMappings: Array<{ partId: string; messageId: string; threadId: string }>,
): Promise<void> {
    if (partMappings.length === 0) {
        return
    }
    const prisma = await getPrisma()
    await prisma.$transaction(
        partMappings.map(({ partId, messageId, threadId }) => {
            return prisma.part_messages.upsert({
                where: { part_id: partId },
                create: { part_id: partId, message_id: messageId, thread_id: threadId },
                update: { message_id: messageId, thread_id: threadId },
            })
        }),
    )
}

// ============================================================================
// Bot Token Functions
// ============================================================================

/**
 * Get the most recent bot token.
 */
export async function getBotToken(): Promise<{ app_id: string; token: string } | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.bot_tokens.findFirst({
        orderBy: { created_at: 'desc' },
    })
    if (!row) {
        return undefined
    }
    return { app_id: row.app_id, token: row.token }
}

/**
 * Store a bot token.
 */
export async function setBotToken(appId: string, token: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.bot_tokens.upsert({
        where: { app_id: appId },
        create: { app_id: appId, token },
        update: { token },
    })
}

// ============================================================================
// Bot API Keys Functions
// ============================================================================

/**
 * Get the Gemini API key for a bot.
 */
export async function getGeminiApiKey(appId: string): Promise<string | null> {
    const prisma = await getPrisma()
    const row = await prisma.bot_api_keys.findUnique({
        where: { app_id: appId },
    })
    return row?.gemini_api_key ?? null
}

/**
 * Set the Gemini API key for a bot.
 * Note: The bot must already have a token (via setBotToken) before calling this.
 */
export async function setGeminiApiKey(appId: string, apiKey: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.bot_api_keys.upsert({
        where: { app_id: appId },
        create: { app_id: appId, gemini_api_key: apiKey },
        update: { gemini_api_key: apiKey },
    })
}

// ============================================================================
// Channel Directory CRUD Functions
// ============================================================================

/**
 * Store a channel-directory mapping.
 * @param skipIfExists If true, behaves like INSERT OR IGNORE - skips if record exists.
 *                     If false (default), behaves like INSERT OR REPLACE - updates if exists.
 */
export async function setChannelDirectory({
    channelId,
    directory,
    channelType,
    appId,
    skipIfExists = false,
}: {
    channelId: string
    directory: string
    channelType: 'text' | 'voice'
    appId?: string | null
    skipIfExists?: boolean
}): Promise<void> {
    const prisma = await getPrisma()
    if (skipIfExists) {
        // INSERT OR IGNORE semantics - only insert if not exists
        const existing = await prisma.channel_directories.findUnique({
            where: { channel_id: channelId },
        })
        if (existing) {
            return
        }
        await prisma.channel_directories.create({
            data: {
                channel_id: channelId,
                directory,
                channel_type: channelType,
                app_id: appId ?? null,
            },
        })
    } else {
        // INSERT OR REPLACE semantics - upsert
        await prisma.channel_directories.upsert({
            where: { channel_id: channelId },
            create: {
                channel_id: channelId,
                directory,
                channel_type: channelType,
                app_id: appId ?? null,
            },
            update: {
                directory,
                channel_type: channelType,
                app_id: appId ?? null,
            },
        })
    }
}

/**
 * Find channels by directory path.
 */
export async function findChannelsByDirectory({
    directory,
    channelType,
    appId,
}: {
    directory?: string
    channelType?: 'text' | 'voice'
    appId?: string
}): Promise<Array<{ channel_id: string; directory: string; channel_type: string }>> {
    const prisma = await getPrisma()
    const where: {
        directory?: string
        channel_type?: string
        app_id?: string
    } = {}
    if (directory) {
        where.directory = directory
    }
    if (channelType) {
        where.channel_type = channelType
    }
    if (appId) {
        where.app_id = appId
    }
    const rows = await prisma.channel_directories.findMany({
        where,
        select: { channel_id: true, directory: true, channel_type: true },
    })
    return rows
}

/**
 * Get all distinct directories with text channels.
 */
export async function getAllTextChannelDirectories(): Promise<string[]> {
    const prisma = await getPrisma()
    const rows = await prisma.channel_directories.findMany({
        where: { channel_type: 'text' },
        select: { directory: true },
        distinct: ['directory'],
    })
    return rows.map((row) => row.directory)
}

/**
 * Delete all channel directories for a specific directory.
 */
export async function deleteChannelDirectoriesByDirectory(directory: string): Promise<void> {
    const prisma = await getPrisma()
    await prisma.channel_directories.deleteMany({
        where: { directory },
    })
}

/**
 * Find a channel by app ID.
 */
export async function findChannelByAppId(appId: string): Promise<string | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.channel_directories.findFirst({
        where: { app_id: appId },
        orderBy: { created_at: 'desc' },
        select: { channel_id: true },
    })
    return row?.channel_id
}

/**
 * Get the directory for a voice channel.
 */
export async function getVoiceChannelDirectory(channelId: string): Promise<string | undefined> {
    const prisma = await getPrisma()
    const row = await prisma.channel_directories.findFirst({
        where: { channel_id: channelId, channel_type: 'voice' },
    })
    return row?.directory
}

/**
 * Find the text channel ID that shares the same directory as a voice channel.
 * Used to send error messages to text channels from voice handlers.
 */
export async function findTextChannelByVoiceChannel(voiceChannelId: string): Promise<string | undefined> {
    const prisma = await getPrisma()
    // First get the directory for the voice channel
    const voiceChannel = await prisma.channel_directories.findFirst({
        where: { channel_id: voiceChannelId, channel_type: 'voice' },
    })
    if (!voiceChannel) {
        return undefined
    }
    // Then find the text channel with the same directory
    const textChannel = await prisma.channel_directories.findFirst({
        where: { directory: voiceChannel.directory, channel_type: 'text' },
    })
    return textChannel?.channel_id
}
