// Filesystem -> Discord sync.
// Reads markdown files and creates/updates/deletes forum threads to match.
// Handles upsert logic: new files create threads, existing files update them.

import fs from 'node:fs'
import path from 'node:path'
import { MessageFlags, type Client, type ForumChannel } from 'discord.js'
import { createLogger } from '../logger.js'
import {
  appendProjectChannelFooter,
  extractStarterContent,
  getStringValue,
  parseFrontmatter,
  toStringArray,
} from './markdown.js'
import { resolveForumChannel } from './discord-operations.js'
import { syncSingleThreadToFile } from './sync-to-files.js'
import {
  ForumSyncOperationError,
  shouldIgnorePath,
  type ForumFileSyncResult,
  type ForumRuntimeState,
  type SyncFilesToForumOptions,
} from './types.js'

const forumLogger = createLogger('FORUM')

// Fields managed by forum sync that should not be set by external writers (e.g. AI model).
// If a file has never been synced (no lastSyncedAt), these fields are stripped to prevent
// model-invented values from causing sync errors (e.g. fake threadId -> fetch fails,
// future lastSyncedAt -> file permanently skipped).
const SYSTEM_MANAGED_FIELDS = [
  'threadId',
  'forumChannelId',
  'lastSyncedAt',
  'lastMessageId',
  'messageCount',
  'author',
  'authorId',
  'createdAt',
  'lastUpdated',
  'project',
  'projectChannelId',
] as const

/** Check that a value is a valid ISO date string that isn't in the future. */
function isValidPastIsoDate({ value }: { value: unknown }): boolean {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  return parsed <= Date.now()
}

function stripSystemFieldsFromUnsyncedFile({
  frontmatter,
}: {
  frontmatter: Record<string, unknown>
}): Record<string, unknown> {
  if (isValidPastIsoDate({ value: frontmatter.lastSyncedAt }))
    return frontmatter
  const cleaned = { ...frontmatter }
  for (const field of SYSTEM_MANAGED_FIELDS) {
    delete cleaned[field]
  }
  return cleaned
}

function isValidDiscordSnowflake({ value }: { value: string }) {
  return /^\d{17,20}$/.test(value)
}

async function collectMarkdownEntries({
  dir,
  outputDir,
}: {
  dir: string
  outputDir: string
}): Promise<Array<{ filePath: string; subfolder?: string }>> {
  const exists = await fs.promises
    .access(dir)
    .then(() => true)
    .catch(() => false)
  if (!exists) return []

  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  const relativeSub = path.relative(outputDir, dir)
  const subfolder = relativeSub && relativeSub !== '.' ? relativeSub : undefined

  const markdownFiles: Array<{ filePath: string; subfolder?: string }> = entries
    .filter((entry) => {
      return entry.isFile() && entry.name.endsWith('.md')
    })
    .map((entry) => {
      return { filePath: path.join(dir, entry.name), subfolder }
    })

  const nestedEntries = await Promise.all(
    entries
      .filter((entry) => {
        return entry.isDirectory()
      })
      .map(async (entry) => {
        return await collectMarkdownEntries({
          dir: path.join(dir, entry.name),
          outputDir,
        })
      }),
  )

  return [...markdownFiles, ...nestedEntries.flat()]
}

function resolveTagIds({
  forumChannel,
  tagNames,
}: {
  forumChannel: ForumChannel
  tagNames: string[]
}): string[] {
  if (tagNames.length === 0) return []
  const normalizedWanted = new Set(
    tagNames.map((tag) => tag.toLowerCase().trim()),
  )
  return forumChannel.availableTags
    .filter((tag) => normalizedWanted.has(tag.name.toLowerCase().trim()))
    .map((tag) => tag.id)
}

/** Ensure all requested tag names exist on the forum channel, creating any missing ones. */
async function ensureForumTags({
  forumChannel,
  tagNames,
}: {
  forumChannel: ForumChannel
  tagNames: string[]
}): Promise<void> {
  if (tagNames.length === 0) return
  const existingNames = new Set(
    forumChannel.availableTags.map((tag) => tag.name.toLowerCase().trim()),
  )
  const missing = tagNames.filter(
    (name) => !existingNames.has(name.toLowerCase().trim()),
  )
  if (missing.length === 0) return
  // Discord forums allow up to 20 tags
  const available = forumChannel.availableTags
  if (available.length + missing.length > 20) return
  await forumChannel
    .setAvailableTags(
      [...available, ...missing.map((name) => ({ name }))],
      `Auto-create tags: ${missing.join(', ')}`,
    )
    .catch((cause) => {
      forumLogger.warn(
        `Failed to create forum tags [${missing.join(', ')}]: ${cause instanceof Error ? cause.message : cause}`,
      )
    })
}

function hasTagName({ tags, tagName }: { tags: string[]; tagName: string }) {
  return tags.some(
    (tag) => tag.toLowerCase().trim() === tagName.toLowerCase().trim(),
  )
}

async function upsertThreadFromFile({
  discordClient,
  forumChannel,
  filePath,
  runtimeState,
  subfolder,
  project,
  projectChannelId,
}: {
  discordClient: Client
  forumChannel: ForumChannel
  filePath: string
  runtimeState?: ForumRuntimeState
  subfolder?: string
  project?: string
  projectChannelId?: string
}): Promise<'created' | 'updated' | 'skipped' | ForumSyncOperationError> {
  if (!fs.existsSync(filePath)) return 'skipped'

  const content = await fs.promises
    .readFile(filePath, 'utf8')
    .catch((cause) => {
      return new ForumSyncOperationError({
        forumChannelId: forumChannel.id,
        reason: `failed to read ${filePath}`,
        cause,
      })
    })
  if (content instanceof Error) return content

  const parsed = parseFrontmatter({ markdown: content })
  const frontmatter = stripSystemFieldsFromUnsyncedFile({
    frontmatter: parsed.frontmatter,
  })
  const rawThreadId = getStringValue({ value: frontmatter.threadId })
  const threadId =
    rawThreadId && isValidDiscordSnowflake({ value: rawThreadId })
      ? rawThreadId
      : ''
  const title =
    getStringValue({ value: frontmatter.title }) ||
    path.basename(filePath, '.md')
  const tags = toStringArray({ value: frontmatter.tags })
  const normalizedSubfolder = subfolder?.replaceAll('\\', '/').toLowerCase()
  const isGlobalSubfolder = Boolean(
    normalizedSubfolder &&
      (normalizedSubfolder === 'global' ||
        normalizedSubfolder.startsWith('global/')),
  )
  const tagsWithScope =
    isGlobalSubfolder && !hasTagName({ tags, tagName: 'global' })
      ? [...tags, 'global']
      : tags
  // Add project name as a forum tag if derived from subfolder
  const allTags =
    project && !hasTagName({ tags: tagsWithScope, tagName: project })
      ? [...tagsWithScope, project]
      : tagsWithScope
  const starterContent = extractStarterContent({ body: parsed.body })
  // Resolve fallback BEFORE appending footer so an empty body doesn't
  // produce a message that is just the channel footer.
  const baseContent = starterContent || title || 'Untitled post'
  const safeStarterContent = appendProjectChannelFooter({
    content: baseContent,
    projectChannelId,
  })

  const stat = await fs.promises.stat(filePath).catch((cause) => {
    return new ForumSyncOperationError({
      forumChannelId: forumChannel.id,
      reason: `failed to stat ${filePath}`,
      cause,
    })
  })
  if (stat instanceof Error) return stat

  // Skip if file hasn't been modified since last sync
  const lastSyncedAt = Date.parse(
    getStringValue({ value: frontmatter.lastSyncedAt }),
  )
  if (Number.isFinite(lastSyncedAt) && stat.mtimeMs <= lastSyncedAt)
    return 'skipped'

  await ensureForumTags({ forumChannel, tagNames: allTags })
  const tagIds = resolveTagIds({ forumChannel, tagNames: allTags })

  // No threadId in frontmatter -> create a new thread
  if (!threadId) {
    return await createNewThread({
      forumChannel,
      filePath,
      title,
      safeStarterContent,
      tagIds,
      runtimeState,
      subfolder,
      project,
      projectChannelId,
    })
  }

  // Thread exists -> update it
  return await updateExistingThread({
    discordClient,
    forumChannel,
    filePath,
    threadId,
    title,
    safeStarterContent,
    tagIds,
    runtimeState,
    subfolder,
    project,
    projectChannelId,
  })
}

async function createNewThread({
  forumChannel,
  filePath,
  title,
  safeStarterContent,
  tagIds,
  runtimeState,
  subfolder,
  project,
  projectChannelId,
}: {
  forumChannel: ForumChannel
  filePath: string
  title: string
  safeStarterContent: string
  tagIds: string[]
  runtimeState?: ForumRuntimeState
  subfolder?: string
  project?: string
  projectChannelId?: string
}): Promise<'created' | ForumSyncOperationError> {
  const created = await forumChannel.threads
    .create({
      name: title.slice(0, 100) || 'Untitled post',
      message: {
        content: safeStarterContent.slice(0, 2_000),
        flags: MessageFlags.SuppressEmbeds,
      },
      appliedTags: tagIds,
    })
    .catch(
      (cause) =>
        new ForumSyncOperationError({
          forumChannelId: forumChannel.id,
          reason: `failed creating thread from ${filePath}`,
          cause,
        }),
    )
  if (created instanceof Error) return created

  // Re-sync the file to get the new threadId in frontmatter.
  // outputDir is path.dirname(filePath) which already includes the subfolder,
  // so we don't pass subfolder again to avoid double-nesting.
  const syncResult = await syncSingleThreadToFile({
    thread: created,
    forumChannel,
    outputDir: path.dirname(filePath),
    runtimeState,
    previousFilePath: filePath,
    project,
    projectChannelId,
  })
  if (syncResult instanceof Error) return syncResult
  return 'created'
}

async function updateExistingThread({
  discordClient,
  forumChannel,
  filePath,
  threadId,
  title,
  safeStarterContent,
  tagIds,
  runtimeState,
  subfolder,
  project,
  projectChannelId,
}: {
  discordClient: Client
  forumChannel: ForumChannel
  filePath: string
  threadId: string
  title: string
  safeStarterContent: string
  tagIds: string[]
  runtimeState?: ForumRuntimeState
  subfolder?: string
  project?: string
  projectChannelId?: string
}): Promise<'updated' | ForumSyncOperationError> {
  const fetchedChannel = await discordClient.channels.fetch(threadId).catch(
    (cause) =>
      new ForumSyncOperationError({
        forumChannelId: forumChannel.id,
        reason: `failed fetching thread ${threadId}`,
        cause,
      }),
  )
  if (fetchedChannel instanceof Error) return fetchedChannel

  if (
    !fetchedChannel ||
    !fetchedChannel.isThread() ||
    fetchedChannel.parentId !== forumChannel.id
  ) {
    return new ForumSyncOperationError({
      forumChannelId: forumChannel.id,
      reason: `thread ${threadId} not found in forum`,
    })
  }

  const updateResult = await fetchedChannel
    .edit({
      name: title.slice(0, 100) || fetchedChannel.name,
      appliedTags: tagIds,
    })
    .catch(
      (cause) =>
        new ForumSyncOperationError({
          forumChannelId: forumChannel.id,
          reason: `failed editing thread ${threadId}`,
          cause,
        }),
    )
  if (updateResult instanceof Error) return updateResult

  const starterMessage = await fetchedChannel
    .fetchStarterMessage()
    .catch((cause) => {
      return new ForumSyncOperationError({
        forumChannelId: forumChannel.id,
        reason: `failed fetching starter message for ${threadId}`,
        cause,
      })
    })
  if (starterMessage instanceof Error) return starterMessage

  if (starterMessage && starterMessage.content !== safeStarterContent) {
    const editResult = await starterMessage
      .edit({
        content: safeStarterContent.slice(0, 2_000),
        flags: MessageFlags.SuppressEmbeds,
      })
      .catch(
        (cause) =>
          new ForumSyncOperationError({
            forumChannelId: forumChannel.id,
            reason: `failed editing starter message for ${threadId}`,
            cause,
          }),
      )
    if (editResult instanceof Error) return editResult
  }

  // Re-sync the file to update frontmatter with latest state.
  // outputDir is path.dirname(filePath) which already includes the subfolder.
  const syncResult = await syncSingleThreadToFile({
    thread: fetchedChannel,
    forumChannel,
    outputDir: path.dirname(filePath),
    runtimeState,
    project,
    projectChannelId,
  })
  if (syncResult instanceof Error) return syncResult
  return 'updated'
}

async function deleteThreadFromFilePath({
  discordClient,
  forumChannel,
  filePath,
}: {
  discordClient: Client
  forumChannel: ForumChannel
  filePath: string
}): Promise<void | ForumSyncOperationError> {
  const filename = path.basename(filePath, '.md')
  if (!/^\d+$/.test(filename)) return

  const threadId = filename
  const fetchedChannel = await discordClient.channels.fetch(threadId).catch(
    (cause) =>
      new ForumSyncOperationError({
        forumChannelId: forumChannel.id,
        reason: `failed fetching deleted thread ${threadId}`,
        cause,
      }),
  )
  if (fetchedChannel instanceof Error) return fetchedChannel

  if (
    !fetchedChannel ||
    !fetchedChannel.isThread() ||
    fetchedChannel.parentId !== forumChannel.id
  ) {
    return
  }

  const deleteResult = await fetchedChannel
    .delete('Deleted from forum sync markdown directory')
    .catch(
      (cause) =>
        new ForumSyncOperationError({
          forumChannelId: forumChannel.id,
          reason: `failed deleting thread ${threadId}`,
          cause,
        }),
    )
  if (deleteResult instanceof Error) return deleteResult
}

export async function syncFilesToForum({
  discordClient,
  forumChannelId,
  outputDir,
  runtimeState,
  changedFilePaths,
  deletedFilePaths,
}: SyncFilesToForumOptions) {
  const forumChannel = await resolveForumChannel({
    discordClient,
    forumChannelId,
  })
  if (forumChannel instanceof Error) return forumChannel

  // When changedFilePaths is provided (from file watcher), derive subfolder from path.
  // Otherwise, recursively scan all markdown files in outputDir.
  const changedEntries: Array<{ filePath: string; subfolder?: string }> =
    changedFilePaths
      ? changedFilePaths.map((filePath) => {
          const rel = path.relative(outputDir, path.dirname(filePath))
          const subfolder = rel && rel !== '.' ? rel : undefined
          return { filePath, subfolder }
        })
      : await collectMarkdownEntries({ dir: outputDir, outputDir })

  // Resolve channel names for subfolders (each subfolder name is a Discord channel ID).
  // Cache resolutions to avoid redundant API calls.
  const channelNameCache = new Map<string, string | null>()
  const resolveChannelName = async (
    channelId: string,
  ): Promise<string | null> => {
    if (channelNameCache.has(channelId)) return channelNameCache.get(channelId)!
    const channel = await discordClient.channels
      .fetch(channelId)
      .catch(() => null)
    const name =
      channel && 'name' in channel && typeof channel.name === 'string'
        ? channel.name
        : null
    channelNameCache.set(channelId, name)
    return name
  }

  const result: ForumFileSyncResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
  }

  for (const { filePath, subfolder } of changedEntries) {
    if (!filePath.endsWith('.md')) continue
    if (runtimeState && shouldIgnorePath({ runtimeState, filePath })) {
      result.skipped += 1
      continue
    }

    // Derive project info from subfolder (subfolder name is the channel ID).
    // Only use subfolder as channelId if it looks like a valid Discord snowflake
    // to prevent nested paths or arbitrary folder names from being treated as IDs.
    const projectChannelId =
      subfolder && isValidDiscordSnowflake({ value: subfolder })
        ? subfolder
        : undefined
    const project = projectChannelId
      ? (await resolveChannelName(projectChannelId)) || undefined
      : undefined

    const upsertResult = await upsertThreadFromFile({
      discordClient,
      forumChannel,
      filePath,
      runtimeState,
      subfolder,
      project,
      projectChannelId,
    })
    // Keep syncing other files even if one file has stale/bad metadata
    // (e.g. threadId that no longer exists). A single bad file should not
    // block watcher startup for the whole memory directory.
    if (upsertResult instanceof Error) {
      forumLogger.warn(`Skipping ${filePath}: ${upsertResult.message}`)
      result.skipped += 1
      continue
    }

    if (upsertResult === 'created') {
      result.created += 1
    } else if (upsertResult === 'updated') {
      result.updated += 1
    } else {
      result.skipped += 1
    }
  }

  for (const filePath of deletedFilePaths || []) {
    const deleteResult = await deleteThreadFromFilePath({
      discordClient,
      forumChannel,
      filePath,
    })
    if (deleteResult instanceof Error) {
      forumLogger.warn(`Skipping delete ${filePath}: ${deleteResult.message}`)
      continue
    }
    result.deleted += 1
  }

  return result
}
