// /btw command - Fork the current session with full context and send a new prompt.
// Unlike /fork, this does not replay past messages in Discord. It just creates
// a new thread, forks the entire session (no messageID), and immediately
// dispatches the user's prompt so the forked session starts working right away.

import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
  MessageFlags,
} from 'discord.js'
import { getThreadSession, setThreadSession } from '../database.js'
import {
  resolveWorkingDirectory,
  resolveTextChannel,
  sendThreadMessage,
} from '../discord-utils.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { createLogger, LogPrefix } from '../logger.js'
import type { CommandContext } from './types.js'
import { initializeOpencodeForDirectory } from '../opencode.js'

const logger = createLogger(LogPrefix.FORK)

export async function forkSessionToBtwThread({
  sourceThread,
  projectDirectory,
  prompt,
  userId,
  username,
  appId,
}: {
  sourceThread: ThreadChannel
  projectDirectory: string
  prompt: string
  userId: string
  username: string
  appId: string | undefined
}): Promise<{ thread: ThreadChannel; forkedSessionId: string } | Error> {
  // Parallelize: session lookup + opencode init + parent channel resolve are independent
  const [sessionId, getClientResult, textChannel] = await Promise.all([
    getThreadSession(sourceThread.id),
    initializeOpencodeForDirectory(projectDirectory),
    resolveTextChannel(sourceThread),
  ])

  if (!sessionId) {
    return new Error('No active session in this thread')
  }
  if (getClientResult instanceof Error) {
    return new Error(`Failed to fork session: ${getClientResult.message}`, {
      cause: getClientResult,
    })
  }
  if (!textChannel) {
    return new Error('Could not resolve parent text channel')
  }

  // Fork must succeed before creating the Discord thread to avoid orphan threads
  const forkResponse = await getClientResult().session.fork({ sessionID: sessionId })
  if (!forkResponse.data) {
    return new Error('Failed to fork session')
  }
  const forkedSession = forkResponse.data

  const thread = await textChannel.threads.create({
    name: `btw: ${prompt}`.slice(0, 100),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: `btw fork from session ${sessionId}`,
  })

  // DB mapping must complete before user-visible actions so the thread is routable
  await setThreadSession(thread.id, forkedSession.id)

  // Parallelize: member add and status message are independent best-effort actions
  const sourceThreadLink = `<#${sourceThread.id}>`
  await Promise.all([
    thread.members.add(userId).catch(() => {}),
    sendThreadMessage(
      thread,
      `Reusing context from ${sourceThreadLink} to answer prompt...\n${prompt}`,
    ),
  ])

  logger.log(
    `Created btw fork session ${forkedSession.id} in thread ${thread.id} from source thread ${sourceThread.id} (session ${sessionId})`,
  )

  const wrappedPrompt = [
    `The user asked a side question while you were working on another task.`,
    `This is a forked session whose ONLY goal is to answer this question.`,
    `Do NOT continue, resume, or reference the previous task. Only answer the question below.\n`,
    prompt,
  ].join('\n')

  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory,
    sdkDirectory: projectDirectory,
    channelId: sourceThread.parentId || sourceThread.id,
    appId,
  })
  await runtime.enqueueIncoming({
    prompt: wrappedPrompt,
    userId,
    username,
    appId,
    mode: 'opencode',
  })

  return {
    thread,
    forkedSessionId: forkedSession.id,
  }
}

export async function handleBtwCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (
    channel.type !== ChannelType.PublicThread
    && channel.type !== ChannelType.PrivateThread
    && channel.type !== ChannelType.AnnouncementThread
  ) {
    await command.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const threadChannel = channel

  const prompt = command.options.getString('prompt', true)

  const resolved = await resolveWorkingDirectory({
    channel: threadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const { projectDirectory } = resolved

  await command.deferReply({ flags: MessageFlags.Ephemeral })

  try {
    const result = await forkSessionToBtwThread({
      sourceThread: threadChannel,
      projectDirectory,
      prompt,
      userId: command.user.id,
      username: command.user.displayName,
      appId,
    })

    if (result instanceof Error) {
      await command.editReply(result.message)
      return
    }

    await command.editReply(
      `Session forked! Continue in ${result.thread.toString()}`,
    )
  } catch (error) {
    logger.error('Error in /btw:', error)
    await command.editReply(
      `Failed to fork session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
