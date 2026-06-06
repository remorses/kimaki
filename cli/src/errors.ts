// TaggedError definitions for type-safe error handling with errore.
// Errors are grouped by category: infrastructure, domain, and validation.
// Use errore.matchError() for exhaustive error handling in command handlers.

import * as errore from 'errore'

// ═══════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE ERRORS - Server, filesystem, external services
// ═══════════════════════════════════════════════════════════════════════════

export class DirectoryNotAccessibleError extends errore.createTaggedError({
  name: 'DirectoryNotAccessibleError',
  message: 'Directory does not exist or is not accessible: $directory',
}) {}

export class ServerStartError extends errore.createTaggedError({
  name: 'ServerStartError',
  message: 'Server failed to start on port $port: $reason',
}) {}

export class ServerNotReadyError extends errore.createTaggedError({
  name: 'ServerNotReadyError',
  message:
    'OpenCode client for directory "$directory" is not available because the shared server is not ready',
}) {}

export class ApiKeyMissingError extends errore.createTaggedError({
  name: 'ApiKeyMissingError',
  message: '$service API key is required',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// ABORT ERRORS - Session cancellation with typed reasons
// ═══════════════════════════════════════════════════════════════════════════

// Extends errore.AbortError so errore.isAbortError() detects it in cause chains.
// Use reason field instead of string matching to identify abort cause.
export class SessionAbortError extends errore.createTaggedError({
  name: 'SessionAbortError',
  message: 'Session aborted: $reason',
  extends: errore.AbortError,
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN ERRORS - Sessions, messages, transcription
// ═══════════════════════════════════════════════════════════════════════════

export class SessionNotFoundError extends errore.createTaggedError({
  name: 'SessionNotFoundError',
  message: 'Session $sessionId not found',
}) {}

export class SessionCreateError extends errore.createTaggedError({
  name: 'SessionCreateError',
}) {}

export class MessagesNotFoundError extends errore.createTaggedError({
  name: 'MessagesNotFoundError',
  message: 'No messages found for session $sessionId',
}) {}

export class TranscriptionError extends errore.createTaggedError({
  name: 'TranscriptionError',
  message: 'Transcription failed: $reason',
}) {}

export class SpeechGenerationError extends errore.createTaggedError({
  name: 'SpeechGenerationError',
  message: 'Speech generation failed: $reason',
}) {}

export class GrepSearchError extends errore.createTaggedError({
  name: 'GrepSearchError',
  message: 'Grep search failed for pattern: $pattern',
}) {}

export class GlobSearchError extends errore.createTaggedError({
  name: 'GlobSearchError',
  message: 'Glob search failed for pattern: $pattern',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION ERRORS - Input validation, format checks
// ═══════════════════════════════════════════════════════════════════════════

export class InvalidAudioFormatError extends errore.createTaggedError({
  name: 'InvalidAudioFormatError',
  message: 'Invalid audio format',
}) {}

export class EmptyTranscriptionError extends errore.createTaggedError({
  name: 'EmptyTranscriptionError',
  message: 'Model returned empty transcription',
}) {}

export class NoResponseContentError extends errore.createTaggedError({
  name: 'NoResponseContentError',
  message: 'No response content from model',
}) {}

export class NoToolResponseError extends errore.createTaggedError({
  name: 'NoToolResponseError',
  message: 'No valid tool responses',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// NETWORK ERRORS - Fetch and HTTP
// ═══════════════════════════════════════════════════════════════════════════

export class FetchError extends errore.createTaggedError({
  name: 'FetchError',
  message: 'Fetch failed for $url',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// API ERRORS - External service responses
// ═══════════════════════════════════════════════════════════════════════════

export class DiscordApiError extends errore.createTaggedError({
  name: 'DiscordApiError',
  message: 'Discord API error: $status $body',
}) {}

export class OpenCodeApiError extends errore.createTaggedError({
  name: 'OpenCodeApiError',
  message: 'OpenCode API error ($status): $body',
}) {}

// ═══════════════════════════════════════════════════════════════════════════
// MERGE/WORKTREE ERRORS
// ═══════════════════════════════════════════════════════════════════════════

export class DirtyWorktreeError extends errore.createTaggedError({
  name: 'DirtyWorktreeError',
  message:
    'Uncommitted changes in worktree. Commit all changes before merging.',
}) {}

export class NothingToMergeError extends errore.createTaggedError({
  name: 'NothingToMergeError',
  message: 'No commits to merge -- branch is already up to date with $target',
}) {}

export class RebaseConflictError extends errore.createTaggedError({
  name: 'RebaseConflictError',
  message:
    'Rebase conflict while rebasing onto $target. Resolve conflicts, then run merge again.',
}) {}

export class RebaseError extends errore.createTaggedError({
  name: 'RebaseError',
  message: 'Rebase onto $target failed',
}) {}

export class NotFastForwardError extends errore.createTaggedError({
  name: 'NotFastForwardError',
  message: 'Cannot fast-forward: $target has commits not in this branch',
}) {}

export class ConflictingFilesError extends errore.createTaggedError({
  name: 'ConflictingFilesError',
  message:
    'Cannot merge: $target worktree has uncommitted changes in overlapping files. Commit changes in main worktree first, then run `/merge-worktree` again.',
}) {}

export class TargetDirtyWorktreeError extends errore.createTaggedError({
  name: 'TargetDirtyWorktreeError',
  message:
    'Cannot merge: $target worktree has uncommitted changes. Commit changes in main worktree first, then run `/merge-worktree` again.',
}) {}

export class PushError extends errore.createTaggedError({
  name: 'PushError',
  message: 'Push to $target failed',
}) {}

export class GitCommandError extends errore.createTaggedError({
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
  | ServerNotReadyError

export type SessionErrors =
  | SessionNotFoundError
  | MessagesNotFoundError
  | OpenCodeApiError

export type SpeechGenerationErrors =
  | ApiKeyMissingError
  | SpeechGenerationError

export type MergeWorktreeErrors =
  | DirtyWorktreeError
  | NothingToMergeError
  | RebaseConflictError
  | RebaseError
  | NotFastForwardError
  | ConflictingFilesError
  | TargetDirtyWorktreeError
  | PushError
  | GitCommandError
