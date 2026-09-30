// Effects executor (spec 27.5): the only Discord writer for session output.
// One promise chain per thread keeps Discord order equal to event order, and
// one typing interval per thread refreshes the indicator every 7s. Never
// awaited by the event loop.

import type { Client } from 'discord.js'

import { createLogger } from './logger.ts'
import type { Effect } from './thread-reducer.ts'

const logger = createLogger('EFFECTS')

const TYPING_REFRESH_MS = 7_000

type ThreadResources = {
  chain: Promise<void>
  typing: ReturnType<typeof setInterval> | null
}

export function createEffectsRunner({ discord }: { discord: Client }) {
  const threads = new Map<string, ThreadResources>()

  function resources(threadId: string): ThreadResources {
    const existing = threads.get(threadId)
    if (existing) return existing
    const created: ThreadResources = { chain: Promise.resolve(), typing: null }
    threads.set(threadId, created)
    return created
  }

  async function sendableChannel(threadId: string) {
    const channel = await discord.channels.fetch(threadId).catch((e: Error) => e)
    if (channel instanceof Error || !channel?.isSendable()) {
      logger.warn(`thread ${threadId} is not sendable`, channel instanceof Error ? channel.message : '')
      return null
    }
    return channel
  }

  async function pulseTyping(threadId: string) {
    const channel = await sendableChannel(threadId)
    if (!channel) return
    await channel.sendTyping().catch((e: Error) => logger.warn(`typing failed in ${threadId}: ${e.message}`))
  }

  function stopTyping(threadId: string) {
    const thread = threads.get(threadId)
    if (!thread?.typing) return
    clearInterval(thread.typing)
    thread.typing = null
  }

  async function runOne(threadId: string, effect: Effect) {
    const thread = resources(threadId)
    if (effect.type === 'typing') {
      if (!effect.on) {
        stopTyping(threadId)
        return
      }
      if (thread.typing) return
      thread.typing = setInterval(() => void pulseTyping(threadId), TYPING_REFRESH_MS)
      await pulseTyping(threadId)
      return
    }
    const channel = await sendableChannel(threadId)
    if (!channel) return
    const sent = await channel
      .send({ content: effect.text, allowedMentions: { parse: ['users'] } })
      .catch((e: Error) => e)
    if (sent instanceof Error) {
      logger.error(`send failed in ${threadId}: ${sent.message}`)
      return
    }
    // A bot message ends the typing indicator in the Discord UI.
    if (thread.typing) await pulseTyping(threadId)
  }

  return {
    run(threadId: string, effects: Effect[]): void {
      if (effects.length === 0) return
      const thread = resources(threadId)
      thread.chain = thread.chain.then(async () => {
        for (const effect of effects) {
          await runOne(threadId, effect)
        }
      })
    },
    stopAll(): void {
      for (const threadId of threads.keys()) stopTyping(threadId)
    },
  }
}

export type EffectsRunner = ReturnType<typeof createEffectsRunner>
