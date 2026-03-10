// Helpers for working with normalized platform channel references in commands.

import type { PlatformChannel, PlatformThread } from '../platform/types.js'

export function isThreadChannel(
  channel: PlatformChannel | null,
): channel is PlatformThread {
  return channel?.kind === 'thread'
}

export function isTextChannel(
  channel: PlatformChannel | null,
): channel is PlatformChannel & { kind: 'text' } {
  return channel?.kind === 'text'
}

export function getRootChannelId(channel: PlatformChannel | null): string | null {
  if (!channel) {
    return null
  }
  if (channel.kind === 'thread') {
    return channel.parentId || channel.id
  }
  return channel.id
}
