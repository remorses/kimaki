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

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const prompt = command.options.getString('prompt', true)

  const resolved = await resolveWorkingDirectory({
    channel: channel as ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const { projectDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await command.editReply({
      content: `Failed to fork session: ${getClient.message}`,
    })
    return
  }

  try {
    // Fork the entire session (no messageID = fork at the latest point)
    const forkResponse = await getClient().session.fork({
      sessionID: sessionId,
    })

    if (!forkResponse.data) {
      await command.editReply('Failed to fork session')
      return
    }

    const forkedSession = forkResponse.data

    const textChannel = await resolveTextChannel(channel as ThreadChannel)
    if (!textChannel) {
      await command.editReply('Could not resolve parent text channel')
      return
    }

    const threadName = `btw: ${prompt}`.slice(0, 100)
    const thread = await textChannel.threads.create({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `btw fork from session ${sessionId}`,
    })

    // Claim the forked session immediately so external polling does not race
    await setThreadSession(thread.id, forkedSession.id)

    await thread.members.add(command.user.id)

    logger.log(
      `Created btw fork session ${forkedSession.id} in thread ${thread.id} from ${sessionId}`,
    )

    // Short status message with prompt instead of replaying past messages
    const sourceThreadLink = `<#${channel.id}>`
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
      userId: command.user.id,
      username: command.user.displayName,
      appId,
      mode: 'opencode',
    })

    await command.editReply(
      `Session forked! Continue in ${thread.toString()}`,
    )
  } catch (error) {
    logger.error('Error in /btw:', error)
    await command.editReply(
      `Failed to fork session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
