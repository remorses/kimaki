// TaggedError definitions for type-safe error handling with errore.
// Errors are grouped by category: infrastructure, domain, and validation.
// Use errore.matchError() for exhaustive error handling in command handlers.

import * as errore from 'errore'

// ═══════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE ERRORS - Server, filesystem, external services
// ═══════════════════════════════════════════════════════════════════════════

export class DirectoryNotAccessibleError extends errore.TaggedError('DirectoryNotAccessibleError')<{
  directory: string
  message: string
}>() {
  constructor(args: { directory: string }) {
    super({ ...args, message: `Directory does not exist or is not accessible: ${args.directory}` })
  }
}

export class ServerStartError extends errore.TaggedError('ServerStartError')<{
  port: number
  reason: string
  message: string
}>() {
  constructor(args: { port: number; reason: string }) {
    super({ ...args, message: `Server failed to start on port ${args.port}: ${args.reason}` })
  }
}

export class ServerNotFoundError extends errore.TaggedError('ServerNotFoundError')<{
  directory: string
  message: string
}>() {
  constructor(args: { directory: string }) {
    super({ ...args, message: `OpenCode server not found for directory: ${args.directory}` })
  }
}

export class ServerNotReadyError extends errore.TaggedError('ServerNotReadyError')<{
  directory: string
  message: string
}>() {
  constructor(args: { directory: string }) {
    super({
      ...args,
      message: `OpenCode server for directory "${args.directory}" is in an error state (no client available)`,
    })
  }
}

export class ApiKeyMissingError extends errore.TaggedError('ApiKeyMissingError')<{
  service: string
  message: string
}>() {
  constructor(args: { service: string }) {
    super({ ...args, message: `${args.service} API key is required` })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN ERRORS - Sessions, messages, transcription
// ═══════════════════════════════════════════════════════════════════════════

export class SessionNotFoundError extends errore.TaggedError('SessionNotFoundError')<{
  sessionId: string
  message: string
}>() {
  constructor(args: { sessionId: string }) {
    super({ ...args, message: `Session ${args.sessionId} not found` })
  }
}

export class SessionCreateError extends errore.TaggedError('SessionCreateError')<{
  message: string
  cause?: unknown
}>() {}

export class MessagesNotFoundError extends errore.TaggedError('MessagesNotFoundError')<{
  sessionId: string
  message: string
}>() {
  constructor(args: { sessionId: string }) {
    super({ ...args, message: `No messages found for session ${args.sessionId}` })
  }
}

export class TranscriptionError extends errore.TaggedError('TranscriptionError')<{
  reason: string
  message: string
  cause?: unknown
}>() {
  constructor(args: { reason: string; cause?: unknown }) {
    super({ ...args, message: `Transcription failed: ${args.reason}` })
  }
}

export class GrepSearchError extends errore.TaggedError('GrepSearchError')<{
  pattern: string
  message: string
  cause?: unknown
}>() {
  constructor(args: { pattern: string; cause?: unknown }) {
    super({ ...args, message: `Grep search failed for pattern: ${args.pattern}` })
  }
}

export class GlobSearchError extends errore.TaggedError('GlobSearchError')<{
  pattern: string
  message: string
  cause?: unknown
}>() {
  constructor(args: { pattern: string; cause?: unknown }) {
    super({ ...args, message: `Glob search failed for pattern: ${args.pattern}` })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION ERRORS - Input validation, format checks
// ═══════════════════════════════════════════════════════════════════════════

export class InvalidAudioFormatError extends errore.TaggedError('InvalidAudioFormatError')<{
  message: string
}>() {
  constructor() {
    super({ message: 'Invalid audio format' })
  }
}

export class EmptyTranscriptionError extends errore.TaggedError('EmptyTranscriptionError')<{
  message: string
}>() {
  constructor() {
    super({ message: 'Model returned empty transcription' })
  }
}

export class NoResponseContentError extends errore.TaggedError('NoResponseContentError')<{
  message: string
}>() {
  constructor() {
    super({ message: 'No response content from model' })
  }
}

export class NoToolResponseError extends errore.TaggedError('NoToolResponseError')<{
  message: string
}>() {
  constructor() {
    super({ message: 'No valid tool responses' })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NETWORK ERRORS - Fetch and HTTP
// ═══════════════════════════════════════════════════════════════════════════

export class FetchError extends errore.TaggedError('FetchError')<{
  url: string
  message: string
  cause?: unknown
}>() {
  constructor(args: { url: string; cause?: unknown }) {
    const causeMsg = args.cause instanceof Error ? args.cause.message : String(args.cause)
    super({ ...args, message: `Fetch failed for ${args.url}: ${causeMsg}` })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API ERRORS - External service responses
// ═══════════════════════════════════════════════════════════════════════════

export class DiscordApiError extends errore.TaggedError('DiscordApiError')<{
  status: number
  message: string
}>() {
  constructor(args: { status: number; body?: string }) {
    super({ ...args, message: `Discord API error: ${args.status}${args.body ? ` - ${args.body}` : ''}` })
  }
}

export class OpenCodeApiError extends errore.TaggedError('OpenCodeApiError')<{
  status: number
  message: string
}>() {
  constructor(args: { status: number; body?: string }) {
    super({ ...args, message: `OpenCode API error (${args.status})${args.body ? `: ${args.body}` : ''}` })
  }
}

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
