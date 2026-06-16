// Detect a /commandname token on its own line in a user prompt and resolve it
// to a registered opencode command. Mirrors the Discord slash command flow
// (commands/user-command.ts) so users can type `/build foo` or `/build-cmd foo`
// in chat, via `/new-session`, through `kimaki send --prompt`, or scheduled
// tasks and have it routed to opencode's session.command API instead of going
// to the model as plain text.
//
// Detection is line-based: we scan each line and return the first one whose
// first non-whitespace token is `/<registered-command>`. This keeps the
// detector oblivious to prefix lines (`» **kimaki-cli:**`, `Context from
// thread:`, etc). Producers that add such prefixes must put them on their
// own line so the user's content starts on a fresh line.

import type { RegisteredUserCommand } from './store.js'
import { store } from './store.js'

const DISCORD_SUFFIXES = ['-mcp-prompt', '-skill', '-cmd'] as const

function stripDiscordSuffix(token: string): string {
  for (const suffix of DISCORD_SUFFIXES) {
    if (token.endsWith(suffix)) {
      return token.slice(0, -suffix.length)
    }
  }
  return token
}

// Resolve a /token against registeredUserCommands. When the list is empty
// (gateway startup race), falls back to suffix-stripping so tokens like
// /build-cmd still route to session.command('build'). Tokens without a
// recognizable suffix return undefined to avoid false positives.
function resolveCommandName({
  token,
  registered,
}: {
  token: string
  registered: RegisteredUserCommand[]
}): string | undefined {
  const exact = registered.find((c) => {
    return c.name === token || c.discordCommandName === token
  })
  if (exact) return exact.name

  const base = stripDiscordSuffix(token)
  if (base === token) return undefined

  const stripped = registered.find((c) => {
    return c.name === base || c.discordCommandName === base
  })
  if (stripped) return stripped.name

  // Empty registry fallback: suffix was stripped, trust it
  if (registered.length === 0) return base

  return undefined
}

export function extractLeadingOpencodeCommand(
  prompt: string,
  registered: RegisteredUserCommand[] = store.getState().registeredUserCommands,
): { command: { name: string; arguments: string } } | null {
  if (!prompt) return null

  for (const line of prompt.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('/')) continue
    const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/)
    if (!match) continue
    const [, token, rest] = match
    if (!token) continue
    const name = resolveCommandName({ token, registered })
    if (!name) continue
    return { command: { name, arguments: (rest ?? '').trim() } }
  }
  return null
}
