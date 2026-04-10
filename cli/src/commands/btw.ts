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
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  resolveWorkingDirectory,
  resolveTextChannel,
  sendThreadMessage,
} from '../discord-utils.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { createLogger, LogPrefix } from '../logger.js'
import type { CommandContext } from './types.js'

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
  const sessionId = await getThreadSession(sourceThread.id)
  if (!sessionId) {
    return new Error('No active session in this thread')
  }

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    return new Error(`Failed to fork session: ${getClient.message}`, {
      cause: getClient,
    })
  }

  const forkResponse = await getClient().session.fork({
    sessionID: sessionId,
  })
  if (!forkResponse.data) {
    return new Error('Failed to fork session')
  }

  const textChannel = await resolveTextChannel(sourceThread)
  if (!textChannel) {
    return new Error('Could not resolve parent text channel')
  }

  const forkedSession = forkResponse.data
  const thread = await textChannel.threads.create({
    name: `btw: ${prompt}`.slice(0, 100),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: `btw fork from session ${sessionId}`,
  })

  await setThreadSession(thread.id, forkedSession.id)
  await thread.members.add(userId)

  logger.log(
    `Created btw fork session ${forkedSession.id} in thread ${thread.id} from ${sessionId}`,
  )

  const sourceThreadLink = `<#${sourceThread.id}>`
  await sendThreadMessage(
    thread,
    `Reusing context from ${sourceThreadLink} to answer prompt...\n${prompt}`,
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
    channelId: textChannel.id,
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
