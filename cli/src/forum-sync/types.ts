// Type definitions, tagged errors, and constants for forum sync.
// All shared types and error classes live here to avoid circular dependencies
// between the sync modules.

import * as errore from 'errore'
import type { Client } from 'discord.js'

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_DEBOUNCE_MS = 800
export const DEFAULT_RATE_LIMIT_DELAY_MS = 250
export const WRITE_IGNORE_TTL_MS = 2_000

// ═══════════════════════════════════════════════════════════════════════════
// TAGGED ERRORS
// ═══════════════════════════════════════════════════════════════════════════

export class ForumChannelResolveError extends errore.createTaggedError({
  name: 'ForumChannelResolveError',
  message: 'Could not resolve forum channel $forumChannelId',
}) {}

export class ForumSyncOperationError extends errore.createTaggedError({
  name: 'ForumSyncOperationError',
  message: 'Forum sync operation failed for forum $forumChannelId: $reason',
}) {}

export class ForumFrontmatterParseError extends errore.createTaggedError({
  name: 'ForumFrontmatterParseError',
  message: 'Failed to parse frontmatter: $reason',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// DATA TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type ForumSyncDirection = 'discord-to-files' | 'bidirectional'

export type ForumSyncEntry = {
  forumChannelId: string
  outputDir: string
  direction: ForumSyncDirection
}

export type ForumMessageSection = {
  messageId: string
  authorName: string
  authorId: string
  createdAt: string
  editedAt: string | null
  content: string
}

export type ForumMarkdownFrontmatter = {
  title: string
  threadId: string
  forumChannelId: string
  tags: string[]
  author: string
  authorId: string
  createdAt: string
  lastUpdated: string
  lastMessageId: string | null
  lastSyncedAt: string
  messageCount: number
  project?: string
  projectChannelId?: string
}

export type ParsedMarkdownFile = {
  frontmatter: Record<string, unknown>
  body: string
}

export type ExistingForumFile = {
  filePath: string
  threadId: string
  frontmatter: Record<string, unknown>
  /** Relative subfolder path from outputDir (e.g. channelId) */
  subfolder?: string
}

export type ForumSyncResult = {
  synced: number
  skipped: number
  deleted: number
}

export type ForumFileSyncResult = {
  created: number
  updated: number
  skipped: number
  deleted: number
}

export type ForumRuntimeState = {
  forumChannelId: string
  outputDir: string
  direction: ForumSyncDirection
  dirtyThreadIds: Set<string>
  ignoredPaths: Map<string, number>
  queuedFileEvents: Map<string, 'create' | 'update' | 'delete'>
  discordDebounceTimer: NodeJS.Timeout | null
  fileDebounceTimer: NodeJS.Timeout | null
}

export type StartForumSyncOptions = {
  discordClient: Client
  appId?: string
}

export type SyncForumToFilesOptions = {
  discordClient: Client
  forumChannelId: string
  outputDir: string
  forceFullRefresh?: boolean
  forceThreadIds?: Set<string>
  runtimeState?: ForumRuntimeState
}

export type SyncFilesToForumOptions = {
  discordClient: Client
  forumChannelId: string
  outputDir: string
  runtimeState?: ForumRuntimeState
  changedFilePaths?: string[]
  deletedFilePaths?: string[]
}

export type LoadedForumConfig = {
  forumChannelId: string
  outputDir: string
  direction: ForumSyncDirection
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

export function delay({ ms }: { ms: number }) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Mark a file path as recently written so the file watcher ignores it. */
export function addIgnoredPath({
  runtimeState,
  filePath,
}: {
  runtimeState?: ForumRuntimeState
  filePath: string
}) {
  if (!runtimeState) return
  runtimeState.ignoredPaths.set(filePath, Date.now() + WRITE_IGNORE_TTL_MS)
}

/** Check if a file path was recently written by us and should be ignored. */
export function shouldIgnorePath({
  runtimeState,
  filePath,
}: {
  runtimeState: ForumRuntimeState
  filePath: string
}) {
  const expiresAt = runtimeState.ignoredPaths.get(filePath)
  if (!expiresAt) return false
  if (expiresAt < Date.now()) {
    runtimeState.ignoredPaths.delete(filePath)
    return false
  }
  return true
}
