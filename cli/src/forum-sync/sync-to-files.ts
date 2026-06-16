// Discord -> filesystem sync.
// Fetches forum threads from Discord and writes them as markdown files.
// Handles incremental sync (skip unchanged threads) and stale file cleanup.

import fs from 'node:fs'
import path from 'node:path'
import type { ForumChannel, ThreadChannel } from 'discord.js'
import { createLogger } from '../logger.js'
import {
  buildMessageSections,
  extractProjectChannelFromContent,
  formatMessageSection,
  getStringValue,
  stringifyFrontmatter,
} from './markdown.js'
import {
  ensureDirectory,
  fetchForumThreads,
  fetchThreadMessages,
  getCanonicalThreadFilePath,
  loadExistingForumFiles,
  resolveForumChannel,
} from './discord-operations.js'
import {
  DEFAULT_RATE_LIMIT_DELAY_MS,
  ForumSyncOperationError,
  addIgnoredPath,
  delay,
  type ForumMarkdownFrontmatter,
  type ForumMessageSection,
  type ForumRuntimeState,
  type ForumSyncResult,
  type SyncForumToFilesOptions,
} from './types.js'

const forumLogger = createLogger('FORUM')

function resolveTagNames({
  thread,
  forumChannel,
}: {
  thread: ThreadChannel
  forumChannel: ForumChannel
}): string[] {
  const availableTagsById = new Map(
    forumChannel.availableTags.map((tag) => [tag.id, tag.name] as const),
  )
  return thread.appliedTags
    .map((tagId) => availableTagsById.get(tagId))
    .filter((tagName): tagName is string => Boolean(tagName))
}

function resolveSubfolderForThread({
  existingSubfolder,
  thread,
  forumChannel,
}: {
  existingSubfolder?: string
  thread: ThreadChannel
  forumChannel: ForumChannel
}) {
  const hasGlobalTag = resolveTagNames({ thread, forumChannel }).some(
    (tagName) => tagName.toLowerCase().trim() === 'global',
  )
  if (hasGlobalTag) return 'global'
  if (existingSubfolder) return existingSubfolder
  return undefined
}

function buildFrontmatter({
  thread,
  forumChannel,
  sections,
  project,
  projectChannelId,
}: {
  thread: ThreadChannel
  forumChannel: ForumChannel
  sections: ForumMessageSection[]
  project?: string
  projectChannelId?: string
}): ForumMarkdownFrontmatter {
  const firstSection = sections[0]
  const createdTimestamp = thread.createdTimestamp ?? Date.now()

  const latestTimestamp = sections.reduce((latest, section) => {
    const created = Date.parse(section.createdAt)
    const edited = section.editedAt ? Date.parse(section.editedAt) : 0
    return Math.max(latest, created, edited)
  }, createdTimestamp)

  return {
    title: thread.name,
    threadId: thread.id,
    forumChannelId: forumChannel.id,
    tags: resolveTagNames({ thread, forumChannel }),
    author: firstSection?.authorName || '',
    authorId: firstSection?.authorId || '',
    createdAt:
      thread.createdAt?.toISOString() ||
      new Date(createdTimestamp).toISOString(),
    lastUpdated: new Date(latestTimestamp).toISOString(),
    lastMessageId: thread.lastMessageId,
    lastSyncedAt: new Date().toISOString(),
    messageCount: sections.length,
    ...(project && { project }),
    ...(projectChannelId && { projectChannelId }),
  }
}

export async function syncSingleThreadToFile({
  thread,
  forumChannel,
  outputDir,
  runtimeState,
  previousFilePath,
  subfolder,
  project,
  projectChannelId,
}: {
  thread: ThreadChannel
  forumChannel: ForumChannel
  outputDir: string
  runtimeState?: ForumRuntimeState
  previousFilePath?: string
  subfolder?: string
  project?: string
  projectChannelId?: string
}): Promise<void | ForumSyncOperationError> {
  const messages = await fetchThreadMessages({ thread })
  if (messages instanceof Error) return messages

  // Extract projectChannelId from the starter message footer if not already known.
  // This allows Discord -> file sync to reconstruct the correct subfolder
  // even when no local .md file exists (e.g. fresh machine, deleted files).
  let resolvedProjectChannelId = projectChannelId
  let resolvedSubfolder = subfolder
  const sections = buildMessageSections({ messages })
  const firstSection = sections[0]
  if (firstSection) {
    const { cleanContent, projectChannelId: footerChannelId } =
      extractProjectChannelFromContent({ content: firstSection.content })
    firstSection.content = cleanContent
    if (footerChannelId && !resolvedProjectChannelId) {
      resolvedProjectChannelId = footerChannelId
    }
    if (resolvedProjectChannelId && !resolvedSubfolder) {
      resolvedSubfolder = resolvedProjectChannelId
    }
  }

  // Ensure subfolder directory exists when writing into a nested path
  if (resolvedSubfolder) {
    const subDir = path.join(outputDir, resolvedSubfolder)
    const ensureResult = await ensureDirectory({ directory: subDir })
    if (ensureResult instanceof Error) return ensureResult
  }
  const body = sections
    .map((section) => formatMessageSection({ section }))
    .join('\n\n---\n\n')
  const frontmatter = buildFrontmatter({
    thread,
    forumChannel,
    sections,
    project,
    projectChannelId: resolvedProjectChannelId,
  })
  const markdown = stringifyFrontmatter({ frontmatter, body })
  const targetPath = getCanonicalThreadFilePath({
    outputDir,
    threadId: thread.id,
    subfolder: resolvedSubfolder,
  })

  addIgnoredPath({ runtimeState, filePath: targetPath })
  const writeResult = await fs.promises
    .writeFile(targetPath, markdown, 'utf8')
    .catch((cause) => {
      return new ForumSyncOperationError({
        forumChannelId: forumChannel.id,
        reason: `failed to write ${targetPath}`,
        cause,
      })
    })
  if (writeResult instanceof Error) return writeResult

  // Clean up old file if thread was renamed (file path changed)
  if (
    previousFilePath &&
    previousFilePath !== targetPath &&
    fs.existsSync(previousFilePath)
  ) {
    addIgnoredPath({ runtimeState, filePath: previousFilePath })
    await fs.promises.unlink(previousFilePath).catch((cause) => {
      forumLogger.warn(
        `Failed to remove old forum file ${previousFilePath}:`,
        cause,
      )
    })
  }
}

export async function syncForumToFiles({
  discordClient,
  forumChannelId,
  outputDir,
  forceFullRefresh = false,
  forceThreadIds,
  runtimeState,
}: SyncForumToFilesOptions) {
  const ensureResult = await ensureDirectory({ directory: outputDir })
  if (ensureResult instanceof Error) {
    return new ForumSyncOperationError({
      forumChannelId,
      reason: `failed to create output directory ${outputDir}`,
      cause: ensureResult,
    })
  }

  const forumChannel = await resolveForumChannel({
    discordClient,
    forumChannelId,
  })
  if (forumChannel instanceof Error) return forumChannel

  const threads = await fetchForumThreads({ forumChannel })
  if (threads instanceof Error) return threads

  const existingFiles = await loadExistingForumFiles({ outputDir })
  const existingByThreadId = new Map(
    existingFiles.map((entry) => [entry.threadId, entry] as const),
  )

  const result: ForumSyncResult = { synced: 0, skipped: 0, deleted: 0 }

  for (const thread of threads) {
    const existing = existingByThreadId.get(thread.id)
    const savedLastMessageId =
      getStringValue({ value: existing?.frontmatter.lastMessageId }) || null
    const isForced = forceFullRefresh || Boolean(forceThreadIds?.has(thread.id))

    if (
      !isForced &&
      savedLastMessageId &&
      savedLastMessageId === thread.lastMessageId
    ) {
      result.skipped += 1
      continue
    }

    const syncResult = await syncSingleThreadToFile({
      thread,
      forumChannel,
      outputDir,
      runtimeState,
      previousFilePath: existing?.filePath,
      subfolder: resolveSubfolderForThread({
        existingSubfolder: existing?.subfolder,
        thread,
        forumChannel,
      }),
      project: getStringValue({ value: existing?.frontmatter.project }),
      projectChannelId: getStringValue({
        value: existing?.frontmatter.projectChannelId,
      }),
    })
    if (syncResult instanceof Error) return syncResult

    result.synced += 1
    await delay({ ms: DEFAULT_RATE_LIMIT_DELAY_MS })
  }

  // Delete files for threads that no longer exist in Discord
  const liveThreadIds = new Set(threads.map((thread) => thread.id))
  for (const existing of existingFiles) {
    if (liveThreadIds.has(existing.threadId)) continue
    if (!fs.existsSync(existing.filePath)) continue

    addIgnoredPath({ runtimeState, filePath: existing.filePath })
    const deleteResult = await fs.promises
      .unlink(existing.filePath)
      .catch((cause) => {
        return new ForumSyncOperationError({
          forumChannelId,
          reason: `failed deleting stale file ${existing.filePath}`,
          cause,
        })
      })
    if (deleteResult instanceof Error) return deleteResult
    result.deleted += 1
  }

  return result
}
