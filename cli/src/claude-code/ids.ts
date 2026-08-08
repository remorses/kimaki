// ID helpers for the Claude Code backend.
//
// Claude-backed sessions live behind the same OpenCode wire protocol as real
// opencode sessions, so every id must be distinguishable at the router layer:
// requests carrying a claude id are handled by the in-process shim, everything
// else is proxied to the real opencode server.

import crypto from 'node:crypto'

const SESSION_PREFIX = 'ses_claude_'
const PERMISSION_PREFIX = 'perm_claude_'
const QUESTION_PREFIX = 'que_claude_'

let counter = 0

/** Monotonic, sortable suffix so message/part ids order correctly. */
function nextOrdinal(): string {
  counter += 1
  return `${Date.now().toString(36)}${counter.toString(36).padStart(6, '0')}`
}

export function createClaudeSessionId(): string {
  return `${SESSION_PREFIX}${crypto.randomBytes(8).toString('hex')}`
}

export function isClaudeCodeSessionId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(SESSION_PREFIX)
}

export function createClaudePermissionId(): string {
  return `${PERMISSION_PREFIX}${crypto.randomBytes(8).toString('hex')}`
}

export function isClaudeCodePermissionId(requestId: string | undefined | null): boolean {
  return typeof requestId === 'string' && requestId.startsWith(PERMISSION_PREFIX)
}

export function createClaudeQuestionId(): string {
  return `${QUESTION_PREFIX}${crypto.randomBytes(8).toString('hex')}`
}

export function isClaudeCodeQuestionId(requestId: string | undefined | null): boolean {
  return typeof requestId === 'string' && requestId.startsWith(QUESTION_PREFIX)
}

export function createClaudeMessageId(): string {
  return `msg_claude_${nextOrdinal()}`
}

export function createClaudePartId(): string {
  return `prt_claude_${nextOrdinal()}`
}

export function createClaudeEventId(): string {
  return `evt_claude_${nextOrdinal()}`
}
