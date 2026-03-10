// Stateless ID converter between Discord and Slack ID formats.
//
// ## Why snowflake-compatible?
//
// discord.js parses message IDs (and sometimes channel IDs) as BigInt
// snowflakes internally — for createdTimestamp, sorting, and caching.
// Non-numeric IDs like "MSG_C04_17000..." cause `Cannot convert to BigInt`
// errors. All IDs we generate MUST be valid BigInt strings.
//
// ## Encoding scheme
//
//   Guild ID:   Slack workspace ID as-is (T04ABC123) — discord.js doesn't
//               parse these as snowflakes in tested code paths
//   Channel ID: Slack channel ID as-is (C04ABC123) — same
//   User ID:    Slack user ID as-is (U04ABC123) — same
//   Thread ID:  numeric Slack ts (dot stripped) — same value as parent
//               message ID, since in Slack a thread IS a message
//   Message ID: numeric Slack ts (dot stripped) — e.g. "1700000000000001"
//
// Thread → parent channel mapping is maintained at runtime in the bridge's
// server state (knownThreads Map) since the numeric thread ID only encodes
// the thread_ts, not the parent Slack channel. This is populated when:
//   1. Webhook event arrives with thread_ts (Slack → Discord direction)
//   2. REST create-thread request (Discord → Slack direction)
//
// ts_no_dots: Slack timestamps have exactly 6 decimal digits
// (e.g. "1503435956.000247"). We strip the dot for encoding and
// re-insert it before the last 6 chars for decoding.

/** Encode a Slack thread_ts into a Discord thread channel ID.
 *  Returns the numeric ts (dot stripped). Same value as the parent message
 *  ID — in Slack, thread identity IS the parent message ts. */
export function encodeThreadId(_channel: string, threadTs: string): string {
  return encodeSlackTs(threadTs)
}

/** Decode a Discord thread channel ID to its Slack thread_ts.
 *  The parent Slack channel must be resolved from the runtime threadMap. */
export function decodeThreadId(threadChannelId: string): {
  threadTs: string
} {
  if (/^\d+$/.test(threadChannelId)) {
    return { threadTs: decodeSlackTs(threadChannelId) }
  }
  // Legacy THR_ format support
  const match = threadChannelId.match(/^THR_([^_]+)_(\d+)$/)
  if (match) {
    return { threadTs: decodeSlackTs(match[2]!) }
  }
  throw new Error(`Invalid thread channel ID: ${threadChannelId}`)
}

/** Encode a Slack ts into a Discord message ID.
 *  Returns the numeric ts (dot stripped) — valid as a BigInt snowflake. */
export function encodeMessageId(_channel: string, ts: string): string {
  return encodeSlackTs(ts)
}

/** Decode a Discord message ID back to Slack ts. */
export function decodeMessageId(messageId: string): {
  ts: string
} {
  // Support legacy MSG_ prefixed IDs
  const legacyMatch = messageId.match(/^MSG_([^_]+)_(\d+)$/)
  if (legacyMatch) {
    return { ts: decodeSlackTs(legacyMatch[2]!) }
  }
  if (/^\d+$/.test(messageId)) {
    return { ts: decodeSlackTs(messageId) }
  }
  throw new Error(`Invalid message ID: ${messageId}`)
}

/** Check if a Discord channel ID represents a Slack thread.
 *  Thread IDs are pure numeric (encoded Slack ts). Slack channel IDs
 *  always have a letter prefix (C, G, D). */
export function isThreadChannelId(id: string): boolean {
  return /^\d{7,}$/.test(id)
}

/** Check if a Discord message ID is an encoded Slack message ts. */
export function isEncodedMessageId(id: string): boolean {
  return /^\d{7,}$/.test(id) || id.startsWith('MSG_')
}

/** Resolve where to send a message given a Discord channel ID.
 *  For thread channels (numeric IDs), looks up the parent Slack channel
 *  from the threadMap. For regular channels, returns the ID as-is. */
export function resolveSlackTarget(
  discordChannelId: string,
  threadMap?: Map<string, string>,
): {
  channel: string
  threadTs?: string
} {
  // Legacy THR_ format
  if (discordChannelId.startsWith('THR_')) {
    const match = discordChannelId.match(/^THR_([^_]+)_(\d+)$/)
    if (match) {
      return { channel: match[1]!, threadTs: decodeSlackTs(match[2]!) }
    }
  }
  // Numeric = thread channel ID (encoded Slack ts)
  if (isThreadChannelId(discordChannelId)) {
    const threadTs = decodeSlackTs(discordChannelId)
    const parentChannel = threadMap?.get(threadTs)
    if (parentChannel) {
      return { channel: parentChannel, threadTs }
    }
    // Unknown thread — can't resolve parent channel. Return the numeric ID
    // as channel (will likely fail downstream, but fail loudly).
    return { channel: discordChannelId }
  }
  // Regular Slack channel ID (C..., G..., D...)
  return { channel: discordChannelId }
}

/**
 * Convert a Slack timestamp to an ISO 8601 string.
 * Slack ts format: "1503435956.000247" where integer part is Unix epoch seconds.
 */
export function slackTsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts)
  return new Date(seconds * 1000).toISOString()
}

export function encodeSlackTs(ts: string): string {
  if (!/^\d+\.\d{6}$/.test(ts)) {
    throw new Error(`Invalid Slack timestamp: ${ts}`)
  }
  return ts.replace(/\./g, '')
}

export function decodeSlackTs(raw: string): string {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid encoded Slack timestamp: ${raw}`)
  }
  if (raw.length <= 6) {
    throw new Error(`Invalid encoded Slack timestamp: ${raw}`)
  }

  const ts = `${raw.slice(0, -6)}.${raw.slice(-6)}`
  if (!/^\d+\.\d{6}$/.test(ts)) {
    throw new Error(`Invalid encoded Slack timestamp: ${raw}`)
  }
  return ts
}

/**
 * Determine the Discord channel_id for an incoming Slack message.
 * If the message is in a thread, returns the encoded thread channel ID
 * (numeric Slack ts). Otherwise returns the Slack channel ID as-is.
 */
export function resolveDiscordChannelId(
  slackChannel: string,
  threadTs?: string,
  messageTs?: string,
): string {
  // If message has a thread_ts different from its own ts, it's a thread reply
  if (threadTs && threadTs !== messageTs) {
    return encodeThreadId(slackChannel, threadTs)
  }
  // If thread_ts equals ts, this is the thread parent -- belongs to the channel
  return slackChannel
}
