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
import {
  getThreadSession,
  setThreadSession,
  getThreadWorktreeOrWorkspace,
  createPendingWorkspace,
  setWorkspaceReady,
} from '../database.js'
import {
  resolveWorkingDirectory,
  resolveTextChannel,
  sendThreadMessage,
} from '../discord-utils.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { createLogger, LogPrefix } from '../logger.js'
import type { CommandContext } from './types.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { copyCurrentSessionModel } from './model.js'
import type { DiscordFileAttachment } from '../message-formatting.js'

const logger = createLogger(LogPrefix.FORK)

export async function forkSessionToBtwThread({
  sourceThread,
  projectDirectory,
  sdkDirectory,
  prompt,
  modelPrompt = prompt,
  userId,
  username,
  appId,
  agent,
  images,
}: {
  sourceThread: ThreadChannel
  projectDirectory: string
  /** Worktree directory when forking from a worktree thread, otherwise same as projectDirectory */
  sdkDirectory: string
  prompt: string
  modelPrompt?: string
  userId: string
  username: string
  appId: string | undefined
  agent?: string
  images?: DiscordFileAttachment[]
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
  const messages = await getClientResult().message.list({
    sessionID: sessionId,
    limit: 1,
    order: 'desc',
  }).catch((error: unknown) => {
    return new Error('Failed to load session messages for fork', { cause: error })
  })
  if (messages instanceof Error) return messages
  const boundaryMessageID = messages.data[0]?.id
  if (!boundaryMessageID) {
    return new Error('Failed to fork session: no messages to copy')
  }
  const forkedSession = await getClientResult().session.fork({
    sessionID: sessionId,
    boundary: { type: 'through' },
  }).catch((error: unknown) => {
    return new Error('Failed to fork session', { cause: error })
  })
  if (forkedSession instanceof Error) return forkedSession
  const channelId = sourceThread.parentId || sourceThread.id

  await copyCurrentSessionModel({
    sourceSessionId: sessionId,
    targetSessionId: forkedSession.id,
    channelId,
    appId,
    getClient: getClientResult,
    directory: sdkDirectory,
  })

  const thread = await textChannel.threads.create({
    name: `btw: ${prompt}`.slice(0, 100),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: `btw fork from session ${sessionId}`,
  })

  // DB mapping must complete before user-visible actions so the thread is routable
  await setThreadSession(thread.id, forkedSession.id)
  const sourceWorkspace = await getThreadWorktreeOrWorkspace(sourceThread.id)
  if (sourceWorkspace?.status === 'ready' && sourceWorkspace.workspace_directory) {
    await createPendingWorkspace({
      threadId: thread.id,
      workspaceType: sourceWorkspace.workspace_type,
      workspaceName: sourceWorkspace.workspace_name ?? '',
      projectDirectory,
    })
    await setWorkspaceReady({
      threadId: thread.id,
      workspaceId: sourceWorkspace.workspace_id ?? undefined,
      workspaceDirectory: sourceWorkspace.workspace_directory,
    })
  }

  // Parallelize: member add and status message are independent best-effort actions
  const sourceThreadLink = `<#${sourceThread.id}>`
  await Promise.all([
    thread.members.add(userId).catch((error) => {
      logger.warn('Could not add fork member:', error)
    }),
    sendThreadMessage(
      thread,
      `Reusing context from ${sourceThreadLink} to answer prompt...\n${prompt}`,
    ),
  ])

  logger.log(
    `Created btw fork session ${forkedSession.id} in thread ${thread.id} from source thread ${sourceThread.id} (session ${sessionId})`,
  )

  // Parent context stays in the user prompt only. Do NOT pass parentSessionId
  // into enqueueIncoming: that would inject a parent block into the system
  // message and bust prompt cache shared with the parent session.
  const wrappedPrompt = [
    `The user asked a side question while you were working on another task.`,
    `This is a forked session whose ONLY goal is to answer this question.`,
    `Do NOT continue, resume, or reference the previous task. Only answer the question below.`,
    ``,
    `Parent session: ${sessionId} (thread <#${sourceThread.id}>)`,
    `Do NOT send messages to the parent session unless the user explicitly asks you to.`,
    ``,
    modelPrompt,
  ].join('\n')

  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory,
    sdkDirectory,
    channelId,
    appId,
    sessionId: forkedSession.id,
  })
  await runtime.enqueueIncoming({
    prompt: wrappedPrompt,
    agent,
    images,
    userId,
    username,
    appId,
    mode: 'opencode',
  }).catch(async (error) => {
    logger.error('Fork dispatch failed:', error)
    await sendThreadMessage(thread, 'Could not send the request to OpenCode. Send your request again in this thread.')
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

  const { projectDirectory, workingDirectory } = resolved

  await command.deferReply({ flags: MessageFlags.Ephemeral })

  try {
    const result = await forkSessionToBtwThread({
      sourceThread: threadChannel,
      projectDirectory,
      sdkDirectory: workingDirectory,
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
