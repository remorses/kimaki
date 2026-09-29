// Detects `. btw` suffix at the end of a Discord message, identical pattern
// to the queue suffix. When present the suffix is stripped and the remaining
// message is forked to a new btw thread via /btw.
//
// Supported forms:
// - punctuation + btw: ". btw", "! btw", ". btw.", "!btw."
// - btw as its own final line: "text\nbtw"
// Non-matches: "btw fix this" (start only), "hello btw" (no punctuation)
//
// Also parses the `!` shell prefix and picks the action a queued message runs.

import { extractQueueSuffix } from './message-formatting.js'

const BTW_SUFFIX_RE = /(?:[.!?,;:])\s*btw\.?\s*$|\n\s*btw\.?\s*$/i
const BTW_QUEUE_SUFFIX_RE = /(?:[.!?,;:])\s*btw\s+queue\.?\s*$|\n\s*btw\s+queue\.?\s*$/i

export function extractBtwSuffix(
  content: string,
): { prompt: string; forceBtw: boolean } {
  if (!BTW_SUFFIX_RE.test(content)) {
    return { prompt: content, forceBtw: false }
  }
  return { prompt: content.replace(BTW_SUFFIX_RE, '').trimEnd(), forceBtw: true }
}

export function extractBtwQueueSuffix(content: string) {
  const queued = BTW_QUEUE_SUFFIX_RE.test(content)
    ? { prompt: content.replace(/\s+queue\.?\s*$/i, ''), forceQueue: true }
    : extractQueueSuffix(content)
  const btw = extractBtwSuffix(queued.prompt)
  return { prompt: btw.prompt, forceQueue: queued.forceQueue, forceBtw: btw.forceBtw }
}

/** `!pnpm build` → `pnpm build`. Null when the text is not a shell command. */
export function parseShellCommand(text: string): string | null {
  if (!text.startsWith('!')) return null
  return text.slice(1).trim() || null
}

/**
 * What a queued item does when the queue reaches it. Plain prompts have no
 * action. `shell` runs a `!cmd`, `btw` forks the session, `context` adds a
 * noReply message once the session is idle.
 */
export type QueuedAction = 'btw' | 'shell' | 'context'

export function getQueuedAction({
  prompt,
  forceBtw,
}: {
  prompt: string
  forceBtw: boolean
}): QueuedAction | undefined {
  if (parseShellCommand(prompt)) return 'shell'
  if (forceBtw) return 'btw'
  return undefined
}
