// Side-session for ". btw". Plugin.Context has no session.fork.

import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
} from 'discord.js'
import { extractBtwSuffix } from '../../src/btw-suffix.ts'
import { createThread, findByThreadId, getContext } from '../threads/registry.ts'

export async function startSideSession({
  text,
  sourceThreadId,
  userId,
  username,
  sourceChannel,
}: {
  text: string
  sourceThreadId: string
  userId: string
  username: string
  sourceChannel: ThreadChannel
}) {
  const stripped = extractBtwSuffix(text)
  if (!stripped.forceBtw) return null
  const record = findByThreadId(sourceThreadId)
  if (!record) return null
  const ctx = getContext(record.directory)
  if (!ctx) return null
  const parent = sourceChannel.parent
  if (!parent || parent.type !== ChannelType.GuildText) return null
  const title = `btw: ${stripped.prompt}`.slice(0, 80)
  // Plugin.Context has no session.fork
  const created = await ctx.session.create({ title })
  const btwThread = await parent.threads.create({
    name: title,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
  })
  await btwThread.members.add(userId)
  await createThread({
    threadId: btwThread.id,
    sessionId: created.id,
    directory: record.directory,
    userId,
    username,
    startedAt: Date.now(),
  })
  await ctx.session.prompt({
    sessionID: created.id,
    text: stripped.prompt,
    metadata: { username, userId },
  })
  return btwThread
}
