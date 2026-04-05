// Detect a leading /commandname token in a user prompt and resolve it to a
// registered opencode command. Mirrors the Discord slash command flow
// (commands/user-command.ts) so users can type `/build foo` or `/build-cmd foo`
// in chat, via `/new-session`, through `kimaki send --prompt`, or scheduled
// tasks and have it routed to opencode's session.command API instead of going
// to the model as plain text.
//
// Prefix handling: CLI-injected messages and /queue reposts carry a
// `» **<username>:** ` prefix before the user's content. We strip that prefix
// before looking for the leading slash so the detection works regardless of
// source.

import type { RegisteredUserCommand } from './store.js'
import { store } from './store.js'

// Matches `» **anything:** ` at the start of the string (CLI + /queue prefix).
// Uses a non-greedy `[\s\S]+?` so usernames containing `*` (rare but allowed
// in Discord display names) still match. The trailing `:** ` anchors the end.
const USER_PREFIX_RE = /^»\s*\*\*[\s\S]+?:\*\*\s*/

const DISCORD_SUFFIXES = ['-mcp-prompt', '-skill', '-cmd'] as const

function stripDiscordSuffix(token: string): string {
  for (const suffix of DISCORD_SUFFIXES) {
    if (token.endsWith(suffix)) {
      return token.slice(0, -suffix.length)
    }
  }
  return token
}

function findRegisteredCommand({
  token,
  registered,
}: {
  token: string
  registered: RegisteredUserCommand[]
}): RegisteredUserCommand | undefined {
  // Try exact matches first (original name, then Discord-sanitized name).
  const exact = registered.find((c) => {
    return c.name === token || c.discordCommandName === token
  })
  if (exact) return exact

  // Fall back to matching after stripping -cmd / -skill / -mcp-prompt from
  // the user's token. This lets `/build-cmd` resolve to an opencode command
  // registered with discordCommandName `build-cmd` via its base name `build`,
  // and also handles users typing the Discord-sanitized form of a namespaced
  // command (e.g. `/foo-bar-cmd` → opencode name `foo:bar` whose discord name
  // is `foo-bar-cmd`).
  const base = stripDiscordSuffix(token)
  if (base === token) return undefined
  return registered.find((c) => {
    return c.name === base || c.discordCommandName === base
  })
}

export function extractLeadingOpencodeCommand(
  prompt: string,
  registered: RegisteredUserCommand[] = store.getState().registeredUserCommands,
): { command: { name: string; arguments: string } } | null {
  if (!prompt) return null
  if (registered.length === 0) return null

  // Strip the `» **kimaki-cli:** ` / `» **Tommy:** ` prefix if present so
  // detection works uniformly for user-typed, CLI-injected, and queued
  // messages.
  const withoutPrefix = prompt.replace(USER_PREFIX_RE, '')
  const trimmed = withoutPrefix.trimStart()
  if (!trimmed.startsWith('/')) return null

  // Capture the first whitespace-delimited token after the leading slash.
  // Rest is everything after the first whitespace run (may span newlines).
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const [, token, rest] = match
  if (!token) return null

  const resolved = findRegisteredCommand({ token, registered })
  if (!resolved) return null

  return {
    command: {
      name: resolved.name,
      arguments: (rest ?? '').trim(),
    },
  }
}
