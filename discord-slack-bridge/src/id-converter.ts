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
//   Message ID: numeric Slack ts (dot stripped) — e.g. "1700000000000001"
//               Always exactly 16 digits for modern timestamps.
//   Thread ID:  reversible encoding of channel + ts:
//               {ts_no_dot_16}{channel_len_2}{channel_base36_pairs}
//               This ensures globally unique thread IDs (no cross-channel
//               collisions) and allows deterministic decoding without a
//               runtime map.
//
// ## Thread ID format detail
//
//   ts_no_dot (16 digits): Slack ts with dot stripped
//   channel_len (2 digits): zero-padded count of chars in Slack channel ID
//   channel_base36_pairs: each char of the Slack channel ID encoded as a
//     2-digit decimal base-36 value (0-9 → 00-09, A-Z → 10-35)
//
//   Example: "C04ABC123" + "1700000000.000001"
//   → "1700000000000001" + "09" + "120004101112010203"
//   → "170000000000000109120004101112010203"
//
//   Thread IDs are always 20+ digits (16 ts + 2 len + 2+ channel).
//   Message IDs are always 16 digits. Slack channel IDs start with a letter.
//   This makes discrimination unambiguous.
//
// ts_no_dots: Slack timestamps have exactly 6 decimal digits
// (e.g. "1503435956.000247"). We strip the dot for encoding and
// re-insert it before the last 6 chars for decoding.

/** Encode a Slack channel ID into a numeric base-36 pair string.
 *  Each character is represented as a 2-digit decimal (00-35). */
export function channelToNumeric(channel: string): string {
  return channel
    .split('')
    .map((c) => {
      const val = parseInt(c, 36)
      if (Number.isNaN(val)) {
        throw new Error(
          `Invalid character '${c}' in Slack channel ID: ${channel}`,
        )
      }
      return val.toString().padStart(2, '0')
    })
    .join('')
}

/** Decode a numeric base-36 pair string back to a Slack channel ID. */
export function numericToChannel(encoded: string): string {
  if (encoded.length % 2 !== 0) {
    throw new Error(`Invalid channel encoding (odd length): ${encoded}`)
  }
  const chars: string[] = []
  for (let i = 0; i < encoded.length; i += 2) {
    const val = parseInt(encoded.slice(i, i + 2), 10)
    if (Number.isNaN(val) || val > 35) {
      throw new Error(
        `Invalid base-36 value at position ${i}: ${encoded.slice(i, i + 2)}`,
      )
    }
    chars.push(val.toString(36).toUpperCase())
  }
  return chars.join('')
}

/** Encode a Slack thread_ts + channel into a Discord thread channel ID.
 *  Format: {ts_no_dot_16}{channel_len_2}{channel_base36_pairs}
 *  Fully reversible — decodeThreadId recovers both channel and threadTs. */
export function encodeThreadId(channel: string, threadTs: string): string {
  const tsEncoded = encodeSlackTs(threadTs)
  const channelEncoded = channelToNumeric(channel)
  const channelLen = channel.length.toString().padStart(2, '0')
  return `${tsEncoded}${channelLen}${channelEncoded}`
}

/** Decode a Discord thread channel ID to its Slack channel + thread_ts.
 *  No runtime map needed — channel is encoded in the ID. */
export function decodeThreadId(threadChannelId: string): {
  channel: string
  threadTs: string
} {
  // New format: {ts_16}{channelLen_2}{channelEncoded}
  if (/^\d{20,}$/.test(threadChannelId)) {
    const tsRaw = threadChannelId.slice(0, 16)
    const channelLen = parseInt(threadChannelId.slice(16, 18), 10)
    const channelEncoded = threadChannelId.slice(18)
    if (channelEncoded.length !== channelLen * 2) {
      throw new Error(
        `Invalid thread channel ID: channel length mismatch in ${threadChannelId}`,
      )
    }
    return {
      channel: numericToChannel(channelEncoded),
      threadTs: decodeSlackTs(tsRaw),
    }
  }
  // Legacy THR_ format support
  const match = threadChannelId.match(/^THR_([^_]+)_(\d+)$/)
  if (match) {
    return { channel: match[1]!, threadTs: decodeSlackTs(match[2]!) }
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
 *  Thread IDs are pure numeric with 20+ digits (ts + channel encoding).
 *  Message IDs are 16 digits. Slack channel IDs start with a letter. */
export function isThreadChannelId(id: string): boolean {
  return /^\d{20,}$/.test(id)
}

/** Check if a Discord message ID is an encoded Slack message ts. */
export function isEncodedMessageId(id: string): boolean {
  // Message IDs are 16 digits. Exclude thread IDs (20+ digits).
  return (/^\d{7,}$/.test(id) && !isThreadChannelId(id)) || id.startsWith('MSG_')
}

/** Resolve where to send a message given a Discord channel ID.
 *  For thread channels (20+ digit numeric), decodes the embedded channel
 *  and threadTs. For regular channels, returns the ID as-is. */
export function resolveSlackTarget(discordChannelId: string): {
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
  // Thread channel ID (20+ digits, encodes channel + ts)
  if (isThreadChannelId(discordChannelId)) {
    const { channel, threadTs } = decodeThreadId(discordChannelId)
    return { channel, threadTs }
  }
  // Regular Slack channel ID (C..., G..., D...)
  if (/^[A-Za-z]/.test(discordChannelId)) {
    return { channel: discordChannelId }
  }
  // Unknown format — fail loudly instead of passing invalid channel
  throw new Error(
    `Cannot resolve Slack target for channel ID: ${discordChannelId}`,
  )
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
 * (with channel embedded). Otherwise returns the Slack channel ID as-is.
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
