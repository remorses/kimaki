// TaggedError definitions for type-safe error handling with errore.
// Errors are grouped by category: infrastructure, domain, and validation.
// Use errore.matchError() for exhaustive error handling in command handlers.

import { createTaggedError } from 'errore'

// ═══════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE ERRORS - Server, filesystem, external services
// ═══════════════════════════════════════════════════════════════════════════

export class DirectoryNotAccessibleError extends createTaggedError({
  name: 'DirectoryNotAccessibleError',
  message: 'Directory does not exist or is not accessible: $directory',
}) {}

export class ServerStartError extends createTaggedError({
  name: 'ServerStartError',
  message: 'Server failed to start on port $port: $reason',
}) {}

export class ServerNotFoundError extends createTaggedError({
  name: 'ServerNotFoundError',
  message: 'OpenCode server not found for directory: $directory',
}) {}

export class ServerNotReadyError extends createTaggedError({
  name: 'ServerNotReadyError',
  message: 'OpenCode server for directory "$directory" is in an error state (no client available)',
}) {}

export class ApiKeyMissingError extends createTaggedError({
  name: 'ApiKeyMissingError',
  message: '$service API key is required',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN ERRORS - Sessions, messages, transcription
// ═══════════════════════════════════════════════════════════════════════════

export class SessionNotFoundError extends createTaggedError({
  name: 'SessionNotFoundError',
  message: 'Session $sessionId not found',
}) {}

export class SessionCreateError extends createTaggedError({
  name: 'SessionCreateError',
  message: '$message',
}) {}

export class MessagesNotFoundError extends createTaggedError({
  name: 'MessagesNotFoundError',
  message: 'No messages found for session $sessionId',
}) {}

export class TranscriptionError extends createTaggedError({
  name: 'TranscriptionError',
  message: 'Transcription failed: $reason',
}) {}

export class GrepSearchError extends createTaggedError({
  name: 'GrepSearchError',
  message: 'Grep search failed for pattern: $pattern',
}) {}

export class GlobSearchError extends createTaggedError({
  name: 'GlobSearchError',
  message: 'Glob search failed for pattern: $pattern',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION ERRORS - Input validation, format checks
// ═══════════════════════════════════════════════════════════════════════════

export class InvalidAudioFormatError extends createTaggedError({
  name: 'InvalidAudioFormatError',
  message: 'Invalid audio format',
}) {}

export class EmptyTranscriptionError extends createTaggedError({
  name: 'EmptyTranscriptionError',
  message: 'Model returned empty transcription',
}) {}

export class NoResponseContentError extends createTaggedError({
  name: 'NoResponseContentError',
  message: 'No response content from model',
}) {}

export class NoToolResponseError extends createTaggedError({
  name: 'NoToolResponseError',
  message: 'No valid tool responses',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// NETWORK ERRORS - Fetch and HTTP
// ═══════════════════════════════════════════════════════════════════════════

export class FetchError extends createTaggedError({
  name: 'FetchError',
  message: 'Fetch failed for $url',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// API ERRORS - External service responses
// ═══════════════════════════════════════════════════════════════════════════

export class DiscordApiError extends createTaggedError({
  name: 'DiscordApiError',
  message: 'Discord API error: $status $body',
}) {}

export class OpenCodeApiError extends createTaggedError({
  name: 'OpenCodeApiError',
  message: 'OpenCode API error ($status): $body',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// MERGE/WORKTREE ERRORS
// ═══════════════════════════════════════════════════════════════════════════

export class DirtyWorktreeError extends createTaggedError({
  name: 'DirtyWorktreeError',
  message: 'Uncommitted changes in worktree. Commit all changes before merging.',
}) {}

export class NothingToMergeError extends createTaggedError({
  name: 'NothingToMergeError',
  message: 'No commits to merge -- branch is already up to date with $target',
}) {}

export class SquashError extends createTaggedError({
  name: 'SquashError',
  message: 'Squash failed: $reason',
}) {}

export class RebaseConflictError extends createTaggedError({
  name: 'RebaseConflictError',
  message: 'Rebase conflict while rebasing onto $target. Resolve conflicts, then run merge again.',
}) {}

export class RebaseError extends createTaggedError({
  name: 'RebaseError',
  message: 'Rebase onto $target failed',
}) {}

export class NotFastForwardError extends createTaggedError({
  name: 'NotFastForwardError',
  message: 'Cannot fast-forward: $target has commits not in this branch',
}) {}

export class ConflictingFilesError extends createTaggedError({
  name: 'ConflictingFilesError',
  message: 'Cannot merge: $target worktree has uncommitted changes in overlapping files',
}) {}

export class PushError extends createTaggedError({
  name: 'PushError',
  message: 'Push to $target failed',
}) {}

export class GitCommandError extends createTaggedError({
  name: 'GitCommandError',
  message: 'Git command failed: $command',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// UNION TYPES - For function signatures
// ═══════════════════════════════════════════════════════════════════════════

export type TranscriptionErrors =
  | ApiKeyMissingError
  | InvalidAudioFormatError
  | TranscriptionError
  | EmptyTranscriptionError
  | NoResponseContentError
  | NoToolResponseError

export type OpenCodeErrors =
  | DirectoryNotAccessibleError
  | ServerStartError
  | ServerNotFoundError
  | ServerNotReadyError

export type SessionErrors = SessionNotFoundError | MessagesNotFoundError | OpenCodeApiError

export type MergeWorktreeErrors =
  | DirtyWorktreeError
  | NothingToMergeError
  | SquashError
  | RebaseConflictError
  | RebaseError
  | NotFastForwardError
  | ConflictingFilesError
  | PushError
  | GitCommandError
