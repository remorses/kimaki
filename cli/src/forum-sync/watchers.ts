// Runtime state management, file watchers, and Discord event listeners.
// Manages the lifecycle of forum sync: initial sync, live Discord event handling,
// file system watcher for bidirectional sync, and debounced sync scheduling.

import fs from 'node:fs'
import parcelWatcher from '@parcel/watcher'
import {
  ChannelType,
  Events,
  type Client,
  type Message,
  type PartialMessage,
  type ThreadChannel,
} from 'discord.js'
import { createLogger } from '../logger.js'
import { readForumSyncConfig } from './config.js'
import {
  ensureDirectory,
  getCanonicalThreadFilePath,
} from './discord-operations.js'
import { syncForumToFiles } from './sync-to-files.js'
import { syncFilesToForum } from './sync-to-discord.js'
import {
  DEFAULT_DEBOUNCE_MS,
  ForumSyncOperationError,
  addIgnoredPath,
  shouldIgnorePath,
  type ForumRuntimeState,
  type ForumSyncDirection,
  type StartForumSyncOptions,
} from './types.js'

const forumLogger = createLogger('FORUM')

// ═══════════════════════════════════════════════════════════════════════════
// MODULE STATE
// ═══════════════════════════════════════════════════════════════════════════

const forumStateById = new Map<string, ForumRuntimeState>()
const watcherUnsubscribeByForumId = new Map<string, () => Promise<void>>()
let discordListenersRegistered = false

// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME STATE
// ═══════════════════════════════════════════════════════════════════════════

function buildRuntimeState({
  forumChannelId,
  outputDir,
  direction,
}: {
  forumChannelId: string
  outputDir: string
  direction: ForumSyncDirection
}): ForumRuntimeState {
  return {
    forumChannelId,
    outputDir,
    direction,
    dirtyThreadIds: new Set<string>(),
    ignoredPaths: new Map<string, number>(),
    queuedFileEvents: new Map<string, 'create' | 'update' | 'delete'>(),
    discordDebounceTimer: null,
    fileDebounceTimer: null,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE WATCHER EVENT HANDLING
// ═══════════════════════════════════════════════════════════════════════════

async function runQueuedFileEvents({
  runtimeState,
  discordClient,
}: {
  runtimeState: ForumRuntimeState
  discordClient: Client
}) {
  const queuedEntries = Array.from(runtimeState.queuedFileEvents.entries())
  runtimeState.queuedFileEvents.clear()

  if (queuedEntries.length === 0) return

  const changedFilePaths = queuedEntries
    .filter(([, eventType]) => eventType === 'create' || eventType === 'update')
    .map(([filePath]) => filePath)
  const deletedFilePaths = queuedEntries
    .filter(([, eventType]) => eventType === 'delete')
    .map(([filePath]) => filePath)

  const fileSyncResult = await syncFilesToForum({
    discordClient,
    forumChannelId: runtimeState.forumChannelId,
    outputDir: runtimeState.outputDir,
    runtimeState,
    changedFilePaths,
    deletedFilePaths,
  })

  if (fileSyncResult instanceof Error) {
    forumLogger.warn(
      `FS -> Discord sync failed for ${runtimeState.forumChannelId}: ${fileSyncResult.message}`,
    )
    return
  }

  if (
    fileSyncResult.created + fileSyncResult.updated + fileSyncResult.deleted >
    0
  ) {
    forumLogger.log(
      `FS -> Discord ${runtimeState.forumChannelId}: +${fileSyncResult.created} ~${fileSyncResult.updated} -${fileSyncResult.deleted} (skip ${fileSyncResult.skipped})`,
    )
  }

  // Refresh the FS mirror for any threads that were touched
  const discordSyncResult = await syncForumToFiles({
    discordClient,
    forumChannelId: runtimeState.forumChannelId,
    outputDir: runtimeState.outputDir,
    runtimeState,
    forceThreadIds: runtimeState.dirtyThreadIds,
  })
  if (discordSyncResult instanceof Error) {
    forumLogger.warn(
      `Discord -> FS refresh failed for ${runtimeState.forumChannelId}: ${discordSyncResult.message}`,
    )
    return
  }
  runtimeState.dirtyThreadIds.clear()
}

function queueFileEvent({
  runtimeState,
  filePath,
  eventType,
  discordClient,
}: {
  runtimeState: ForumRuntimeState
  filePath: string
  eventType: 'create' | 'update' | 'delete'
  discordClient: Client
}) {
  if (shouldIgnorePath({ runtimeState, filePath })) return

  runtimeState.queuedFileEvents.set(filePath, eventType)

  if (runtimeState.fileDebounceTimer) {
    clearTimeout(runtimeState.fileDebounceTimer)
  }

  runtimeState.fileDebounceTimer = setTimeout(() => {
    runtimeState.fileDebounceTimer = null
    void runQueuedFileEvents({ runtimeState, discordClient })
  }, DEFAULT_DEBOUNCE_MS)
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCORD EVENT HANDLING
// ═══════════════════════════════════════════════════════════════════════════

function scheduleDiscordSync({
  runtimeState,
  threadId,
  discordClient,
}: {
  runtimeState: ForumRuntimeState
  threadId: string
  discordClient: Client
}) {
  runtimeState.dirtyThreadIds.add(threadId)

  if (runtimeState.discordDebounceTimer) {
    clearTimeout(runtimeState.discordDebounceTimer)
  }

  runtimeState.discordDebounceTimer = setTimeout(() => {
    runtimeState.discordDebounceTimer = null
    void (async () => {
      const syncResult = await syncForumToFiles({
        discordClient,
        forumChannelId: runtimeState.forumChannelId,
        outputDir: runtimeState.outputDir,
        runtimeState,
        forceThreadIds: runtimeState.dirtyThreadIds,
      })
      if (syncResult instanceof Error) {
        forumLogger.warn(
          `Debounced Discord -> FS sync failed for ${runtimeState.forumChannelId}: ${syncResult.message}`,
        )
        return
      }
      runtimeState.dirtyThreadIds.clear()
    })()
  }, DEFAULT_DEBOUNCE_MS)
}

function getThreadEventData({
  channel,
}: {
  channel: ThreadChannel | null
}): { forumChannelId: string; threadId: string } | null {
  if (!channel) return null
  if (
    channel.type !== ChannelType.PublicThread &&
    channel.type !== ChannelType.PrivateThread &&
    channel.type !== ChannelType.AnnouncementThread
  ) {
    return null
  }
  if (!channel.parentId) return null
  return { forumChannelId: channel.parentId, threadId: channel.id }
}

function getEventThreadFromMessage({
  message,
}: {
  message: Message | PartialMessage
}): ThreadChannel | null {
  const channel = message.channel
  if (!channel || !channel.isThread()) return null
  return channel
}

function tryHandleThreadEvent({
  channel,
  discordClient,
}: {
  channel: ThreadChannel | null
  discordClient: Client
}) {
  const data = getThreadEventData({ channel })
  if (!data) return
  const runtimeState = forumStateById.get(data.forumChannelId)
  if (!runtimeState) return
  scheduleDiscordSync({ runtimeState, threadId: data.threadId, discordClient })
}

/**
 * Find the file path for a thread, checking root and one level of subdirectories.
 */
function findThreadFilePath({
  outputDir,
  threadId,
}: {
  outputDir: string
  threadId: string
}): string | null {
  const rootPath = getCanonicalThreadFilePath({ outputDir, threadId })
  if (fs.existsSync(rootPath)) return rootPath

  const dirEntries = (() => {
    try {
      return fs.readdirSync(outputDir, { withFileTypes: true })
    } catch {
      return []
    }
  })()
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue
    const subPath = getCanonicalThreadFilePath({
      outputDir,
      threadId,
      subfolder: entry.name,
    })
    if (fs.existsSync(subPath)) return subPath
  }
  return null
}

function registerDiscordSyncListeners({
  discordClient,
}: {
  discordClient: Client
}) {
  if (discordListenersRegistered) return
  discordListenersRegistered = true

  discordClient.on(Events.MessageCreate, (message) => {
    if (message.author?.bot) return
    const thread = getEventThreadFromMessage({ message })
    tryHandleThreadEvent({ channel: thread, discordClient })
  })

  discordClient.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
    const thread = getEventThreadFromMessage({ message: newMessage })
    tryHandleThreadEvent({ channel: thread, discordClient })
  })

  discordClient.on(Events.ThreadUpdate, (_oldThread, newThread) => {
    tryHandleThreadEvent({ channel: newThread, discordClient })
  })

  discordClient.on(Events.ThreadDelete, async (thread) => {
    const data = getThreadEventData({ channel: thread })
    if (!data) return
    const runtimeState = forumStateById.get(data.forumChannelId)
    if (!runtimeState) return
    const targetPath = findThreadFilePath({
      outputDir: runtimeState.outputDir,
      threadId: data.threadId,
    })
    if (!targetPath) return
    addIgnoredPath({ runtimeState, filePath: targetPath })
    await fs.promises.unlink(targetPath).catch((cause) => {
      forumLogger.warn(
        `Failed to delete forum file on thread delete ${targetPath}:`,
        cause,
      )
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE WATCHER SETUP
// ═══════════════════════════════════════════════════════════════════════════

async function startWatcherForRuntimeState({
  runtimeState,
  discordClient,
}: {
  runtimeState: ForumRuntimeState
  discordClient: Client
}): Promise<void | ForumSyncOperationError> {
  if (runtimeState.direction !== 'bidirectional') return

  const subscription = await parcelWatcher
    .subscribe(runtimeState.outputDir, (_error, events) => {
      const mdEvents = events.filter((event) => event.path.endsWith('.md'))
      mdEvents
        .filter(
          (event) =>
            event.type === 'create' ||
            event.type === 'update' ||
            event.type === 'delete',
        )
        .map((event) => {
          queueFileEvent({
            runtimeState,
            filePath: event.path,
            eventType: event.type as 'create' | 'update' | 'delete',
            discordClient,
          })
        })
    })
    .catch(
      (cause) =>
        new ForumSyncOperationError({
          forumChannelId: runtimeState.forumChannelId,
          reason: `failed to subscribe watcher for ${runtimeState.outputDir}`,
          cause,
        }),
    )

  if (subscription instanceof Error) return subscription

  watcherUnsubscribeByForumId.set(runtimeState.forumChannelId, () => {
    return subscription.unsubscribe()
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

export async function stopConfiguredForumSync() {
  const unsubscribers = Array.from(watcherUnsubscribeByForumId.values())
  watcherUnsubscribeByForumId.clear()
  forumStateById.clear()

  await Promise.all(
    unsubscribers.map(async (unsubscribe) => {
      await unsubscribe().catch((cause) => {
        forumLogger.warn('Failed to unsubscribe forum watcher:', cause)
      })
    }),
  )
}

export async function startConfiguredForumSync({
  discordClient,
  appId,
}: StartForumSyncOptions) {
  const loadedConfig = await readForumSyncConfig({ appId })
  if (loadedConfig instanceof Error) return loadedConfig

  if (loadedConfig.length === 0) return

  registerDiscordSyncListeners({ discordClient })

  // Process each config independently so one stale/deleted forum channel
  // doesn't block the watcher from starting for other valid configs.
  for (const entry of loadedConfig) {
    const runtimeState = buildRuntimeState({
      forumChannelId: entry.forumChannelId,
      outputDir: entry.outputDir,
      direction: entry.direction,
    })
    forumStateById.set(entry.forumChannelId, runtimeState)

    const ensureResult = await ensureDirectory({ directory: entry.outputDir })
    if (ensureResult instanceof Error) {
      forumLogger.warn(
        `Skipping forum ${entry.forumChannelId}: failed to create ${entry.outputDir}`,
      )
      continue
    }

    const fileToDiscordResult = await syncFilesToForum({
      discordClient,
      forumChannelId: entry.forumChannelId,
      outputDir: entry.outputDir,
      runtimeState,
    })
    if (fileToDiscordResult instanceof Error) {
      forumLogger.warn(
        `Skipping forum ${entry.forumChannelId}: FS->Discord sync failed: ${fileToDiscordResult.message}`,
      )
      continue
    }

    const discordToFileResult = await syncForumToFiles({
      discordClient,
      forumChannelId: entry.forumChannelId,
      outputDir: entry.outputDir,
      forceFullRefresh: true,
      runtimeState,
    })
    if (discordToFileResult instanceof Error) {
      forumLogger.warn(
        `Skipping forum ${entry.forumChannelId}: Discord->FS sync failed: ${discordToFileResult.message}`,
      )
      continue
    }

    const watcherResult = await startWatcherForRuntimeState({
      runtimeState,
      discordClient,
    })
    if (watcherResult instanceof Error) {
      forumLogger.warn(
        `Skipping forum ${entry.forumChannelId}: watcher failed: ${watcherResult.message}`,
      )
      continue
    }

    forumLogger.log(
      `Forum sync started for ${entry.forumChannelId} (${entry.direction}) -> ${entry.outputDir}`,
    )
    forumLogger.log(
      `Initial sync: Discord->FS synced ${discordToFileResult.synced}, skipped ${discordToFileResult.skipped}, deleted ${discordToFileResult.deleted}; FS->Discord created ${fileToDiscordResult.created}, updated ${fileToDiscordResult.updated}, deleted ${fileToDiscordResult.deleted}`,
    )
  }
}
