import * as errore from 'errore'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const discordLogger = createLogger(LogPrefix.DISCORD)

// Dedup window for toasts (10 seconds)
const TOAST_DEDUP_WINDOW_MS = 10_000
// Module-scoped in-memory Map for dedup state: key -> lastSentTimestamp(ms)
const toastDedupMap: Map<string, number> = new Map()

const TOAST_SESSION_ID_REGEX = /\b(ses_[A-Za-z0-9]+)\b\s*$/u

export function extractToastSessionId({ message }: { message: string }): string | undefined {
  const match = message.match(TOAST_SESSION_ID_REGEX)
  return match?.[1]
}

export function stripToastSessionId({ message }: { message: string }): string {
  return message.replace(TOAST_SESSION_ID_REGEX, '').trimEnd()
}

/**
 * Normalize a toast key for deduplication.
 *
 * Rules:
 * - Strip trailing session IDs using stripToastSessionId()
 * - Remove leading non-alphanumeric characters (spinner glyphs like · • ● ○ ◌ ◦,
 *   Braille patterns, box-drawing, etc.) from both title AND message
 * - Collapse whitespace, trim, lowercase
 * - Include the variant to avoid cross-variant collisions
 */
export function normalizeToastKey(
  variant: 'info' | 'success' | 'warning' | 'error',
  title: string | undefined,
  message: string,
): string {
  const strippedMessage = stripToastSessionId({ message })
    .replace(/^[^\p{L}\p{N}]+/u, '')   // strip leading non-alphanumeric (spinner glyphs)
    .replace(/\s+/gu, ' ')
    .trim()
  const titleRaw = title ?? ''
  // Remove leading spinner glyphs and surrounding whitespace from title
  const titleNoSpinner = titleRaw.replace(/^[·•●○◌◦\s]+/u, '').replace(/\s+/gu, ' ').trim()
  const joined = `${variant}|${titleNoSpinner}|${strippedMessage}`
  return joined.toLowerCase()
}

function cleanupExpiredToastDedupEntries(): void {
  const now = Date.now()
  for (const [k, ts] of toastDedupMap) {
    if (now - ts >= TOAST_DEDUP_WINDOW_MS) {
      toastDedupMap.delete(k)
    }
  }
}

export async function handleTuiToast(this: any, properties: {
  title?: string
  message: string
  variant: 'info' | 'success' | 'warning' | 'error'
  duration?: number
}): Promise<void> {
  // warning toasts are suppressed entirely
  if (properties.variant === 'warning') {
    return
  }

  const toastMessage = stripToastSessionId({ message: properties.message }).trim()
  if (!toastMessage) {
    return
  }

  const titlePrefix = properties.title ? `${properties.title.trim()}: ` : ''
  const chunk = `⬦ ${properties.variant}: ${titlePrefix}${toastMessage}`

  // error toasts always pass through (no dedup)
  if (properties.variant === 'error') {
    const toastResult = await errore.tryAsync(() => {
      return this.thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
    })
    if (toastResult instanceof Error) {
      discordLogger.error('Failed to send toast notice:', toastResult)
    }
    return
  }

  // For info/success - dedupe
  cleanupExpiredToastDedupEntries()
  const key = normalizeToastKey(properties.variant, properties.title, toastMessage)
  const lastTs = toastDedupMap.get(key)
  const now = Date.now()
  if (lastTs && now - lastTs < TOAST_DEDUP_WINDOW_MS) {
    // Suppress duplicate toast within TTL
    return
  }

  // Mark-before-send: reserve the dedup key before the async send
  toastDedupMap.set(key, now)
  const toastResult = await errore.tryAsync(() => {
    return this.thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
  })
  if (toastResult instanceof Error) {
    // rollback the reserved key on failure so retries are allowed immediately
    toastDedupMap.delete(key)
    discordLogger.error('Failed to send toast notice:', toastResult)
  }
}