// Discord API operations for forum sync.
// Resolves forum channels, fetches threads (active + archived) with pagination,
// fetches thread messages, loads existing forum files from disk, and ensures directories.

import fs from 'node:fs'
import path from 'node:path'
import {
  ChannelType,
  type Client,
  type ForumChannel,
  type Message,
  type ThreadChannel,
} from 'discord.js'
import { createLogger } from '../logger.js'
import { parseFrontmatter, getStringValue } from './markdown.js'
import {
  DEFAULT_RATE_LIMIT_DELAY_MS,
  ForumChannelResolveError,
  ForumSyncOperationError,
  delay,
  type ExistingForumFile,
} from './types.js'

const forumLogger = createLogger('FORUM')

export function getCanonicalThreadFilePath({
  outputDir,
  threadId,
  subfolder,
}: {
  outputDir: string
  threadId: string
  subfolder?: string
}) {
  if (subfolder) {
    return path.join(outputDir, subfolder, `${threadId}.md`)
  }
  return path.join(outputDir, `${threadId}.md`)
}

export async function ensureDirectory({ directory }: { directory: string }) {
  const result = await fs.promises.mkdir(directory, { recursive: true }).catch(
    (cause) =>
      new ForumSyncOperationError({
        forumChannelId: 'unknown',
        reason: directory,
        cause,
      }),
  )
  if (result instanceof Error) return result
}

export async function resolveForumChannel({
  discordClient,
  forumChannelId,
}: {
  discordClient: Client
  forumChannelId: string
}): Promise<ForumChannel | ForumChannelResolveError> {
  const channel = await discordClient.channels
    .fetch(forumChannelId)
    .catch((cause) => new ForumChannelResolveError({ forumChannelId, cause }))
  if (channel instanceof Error) return channel

  if (!channel || channel.type !== ChannelType.GuildForum) {
    return new ForumChannelResolveError({ forumChannelId })
  }

  return channel
}

export async function fetchForumThreads({
  forumChannel,
}: {
  forumChannel: ForumChannel
}): Promise<ThreadChannel[] | ForumSyncOperationError> {
  const byId = new Map<string, ThreadChannel>()

  const active = await forumChannel.threads.fetchActive().catch(
    (cause) =>
      new ForumSyncOperationError({
        forumChannelId: forumChannel.id,
        reason: 'fetchActive failed',
        cause,
      }),
  )
  if (active instanceof Error) return active

  for (const [id, thread] of active.threads) {
    byId.set(id, thread)
  }

  let before: Date | undefined
  while (true) {
    const archived = await forumChannel.threads
      .fetchArchived({ type: 'public', limit: 100, before })
      .catch(
        (cause) =>
          new ForumSyncOperationError({
            forumChannelId: forumChannel.id,
            reason: 'fetchArchived failed',
            cause,
          }),
      )
    if (archived instanceof Error) return archived

    const threads = Array.from(archived.threads.values())
    for (const thread of threads) {
      byId.set(thread.id, thread)
    }

    if (!archived.hasMore || threads.length === 0) break

    const timestamps = threads
      .map((thread) => thread.archiveTimestamp ?? thread.createdTimestamp)
      .filter((value): value is number => value !== null)

    const oldestTimestamp = Math.min(...timestamps)
    if (!Number.isFinite(oldestTimestamp)) break

    before = new Date(oldestTimestamp - 1)
    await delay({ ms: DEFAULT_RATE_LIMIT_DELAY_MS })
  }

  return Array.from(byId.values())
}

export async function fetchThreadMessages({
  thread,
}: {
  thread: ThreadChannel
}): Promise<Message[] | ForumSyncOperationError> {
  const byId = new Map<string, Message>()
  let before: string | undefined

  while (true) {
    const fetched = await thread.messages.fetch({ limit: 100, before }).catch(
      (cause) =>
        new ForumSyncOperationError({
          forumChannelId: thread.parentId || 'unknown',
          reason: `message fetch failed for thread ${thread.id}`,
          cause,
        }),
    )
    if (fetched instanceof Error) return fetched

    const messages = Array.from(fetched.values())
    for (const message of messages) {
      byId.set(message.id, message)
    }

    if (messages.length < 100 || messages.length === 0) break

    // Find oldest message for cursor - messages are sorted by Discord, last is oldest
    const oldest = messages[messages.length - 1]
    if (!oldest) break

    before = oldest.id
    await delay({ ms: DEFAULT_RATE_LIMIT_DELAY_MS })
  }

  return Array.from(byId.values()).sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp,
  )
}

/**
 * Recursively walks a directory collecting all .md files with their relative subfolder path.
 */
async function collectMarkdownFiles({
  dir,
  outputDir,
}: {
  dir: string
  outputDir: string
}): Promise<Array<{ filePath: string; subfolder?: string }>> {
  if (!fs.existsSync(dir)) return []

  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  const relativeSub = path.relative(outputDir, dir)
  const subfolder = relativeSub && relativeSub !== '.' ? relativeSub : undefined

  const mdFiles: Array<{ filePath: string; subfolder?: string }> = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => ({ filePath: path.join(dir, entry.name), subfolder }))

  const subdirs = entries.filter((entry) => entry.isDirectory())
  const nestedResults = await Promise.all(
    subdirs.map((subdir) =>
      collectMarkdownFiles({
        dir: path.join(dir, subdir.name),
        outputDir,
      }),
    ),
  )

  return [...mdFiles, ...nestedResults.flat()]
}

export async function loadExistingForumFiles({
  outputDir,
}: {
  outputDir: string
}): Promise<ExistingForumFile[]> {
  const markdownEntries = await collectMarkdownFiles({
    dir: outputDir,
    outputDir,
  })

  const loaded = await Promise.all(
    markdownEntries.map(async ({ filePath, subfolder }) => {
      const content = await fs.promises
        .readFile(filePath, 'utf8')
        .catch((cause) => {
          forumLogger.warn(`Failed to read forum file ${filePath}:`, cause)
          return null
        })
      if (content === null) return null

      const parsed = parseFrontmatter({ markdown: content })
      const threadIdFromFrontmatter = getStringValue({
        value: parsed.frontmatter.threadId,
      })
      const threadIdFromFilename = path.basename(filePath, '.md')
      const threadId =
        threadIdFromFrontmatter ||
        (/^\d+$/.test(threadIdFromFilename) ? threadIdFromFilename : '')
      if (!threadId) return null

      const result: ExistingForumFile = {
        filePath,
        threadId,
        frontmatter: parsed.frontmatter,
        subfolder,
      }
      return result
    }),
  )

  return loaded.filter((item): item is ExistingForumFile => item !== null)
}
