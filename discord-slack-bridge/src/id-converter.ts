// Stateless ID converter between Discord and Slack ID formats.
// No database needed -- all conversions are deterministic and reversible.
//
// Encoding scheme:
//   Guild ID:   Slack workspace ID as-is (T04ABC123)
//   Channel ID: Slack channel ID as-is (C04ABC123, G04ABC123, D04ABC123)
//   Thread ID:  THR_{channel}_{ts_no_dots} (thread channels in Discord)
//   Message ID: MSG_{channel}_{ts_no_dots}
//   User ID:    Slack user ID as-is (U04ABC123, W04ABC123)
//
// ts_no_dots: Slack timestamps have exactly 6 decimal digits
// (e.g. "1503435956.000247"). We strip the dot for encoding and
// re-insert it before the last 6 chars for decoding.

/** Encode a Slack (channel, thread_ts) pair into a Discord thread channel ID */
export function encodeThreadId(channel: string, threadTs: string): string {
  return `THR_${channel}_${threadTs.replace('.', '')}`
}

/** Decode a Discord thread channel ID back to Slack (channel, thread_ts) */
export function decodeThreadId(threadChannelId: string): {
  channel: string
  threadTs: string
} {
  const match = threadChannelId.match(/^THR_([^_]+)_(\d+)$/)
  if (!match) {
    throw new Error(`Invalid thread channel ID: ${threadChannelId}`)
  }
  const raw = match[2]!
  const ts = raw.slice(0, -6) + '.' + raw.slice(-6)
  return { channel: match[1]!, threadTs: ts }
}

/** Encode a Slack (channel, ts) pair into a Discord message ID */
export function encodeMessageId(channel: string, ts: string): string {
  return `MSG_${channel}_${ts.replace('.', '')}`
}

/** Decode a Discord message ID back to Slack (channel, ts) */
export function decodeMessageId(messageId: string): {
  channel: string
  ts: string
} {
  const match = messageId.match(/^MSG_([^_]+)_(\d+)$/)
  if (!match) {
    throw new Error(`Invalid message ID: ${messageId}`)
  }
  const raw = match[2]!
  const ts = raw.slice(0, -6) + '.' + raw.slice(-6)
  return { channel: match[1]!, ts }
}

/** Check if a Discord channel ID represents a Slack thread */
export function isThreadChannelId(id: string): boolean {
  return id.startsWith('THR_')
}

/** Check if a Discord message ID is an encoded Slack message */
export function isEncodedMessageId(id: string): boolean {
  return id.startsWith('MSG_')
}

/**
 * Resolve where to send a message given a Discord channel ID.
 * If the ID is a thread (THR_...), returns the parent channel + thread_ts.
 * Otherwise returns the channel ID as-is.
 */
export function resolveSlackTarget(discordChannelId: string): {
  channel: string
  threadTs?: string
} {
  if (isThreadChannelId(discordChannelId)) {
    const { channel, threadTs } = decodeThreadId(discordChannelId)
    return { channel, threadTs }
  }
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

/**
 * Determine the Discord channel_id for an incoming Slack message.
 * If the message is in a thread, returns the encoded thread channel ID.
 * Otherwise returns the Slack channel ID as-is.
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
