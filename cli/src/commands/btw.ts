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
import { copySessionPreferences } from './model.js'
import type { DiscordFileAttachment } from '../message-formatting.js'
import { extractQueueSuffix } from '../message-formatting.js'

const logger = createLogger(LogPrefix.FORK)

// Resolves to [value, elapsed ms] so each btw setup step can be logged.
async function timed<T>(promise: Promise<T>): Promise<[T, number]> {
  const start = Date.now()
  const value = await promise
  return [value, Date.now() - start]
}

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
  const startedAt = Date.now()
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

  // Fork and thread creation are independent round trips, so run them together.
  // If either side fails, remove whichever side succeeded.
  // session.fork copies messages, agent, model and the kimaki instruction
  // entry, so the fork keeps the source prompt prefix and cache.
  const [forkSettled, threadSettled] = await Promise.allSettled([
    getClientResult().session.fork({
      sessionID: sessionId,
      boundary: { type: 'through' },
    }),
    textChannel.threads.create({
      name: `btw: ${prompt}`.slice(0, 100),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `btw fork from session ${sessionId}`,
    }),
  ])
  const forkedSession = forkSettled.status === 'fulfilled' ? forkSettled.value : undefined
  const createdThread = threadSettled.status === 'fulfilled' ? threadSettled.value : undefined
  if (!forkedSession || !createdThread) {
    await Promise.all([
      createdThread?.delete('btw fork setup failed').catch((error) => {
        logger.warn(`Could not delete orphan btw thread ${createdThread.id}:`, error)
      }),
      forkedSession && getClientResult()
        .session.remove({ sessionID: forkedSession.id })
        .catch((error: unknown) => {
          logger.warn(`Could not delete orphan btw session ${forkedSession.id}:`, error)
        }),
    ])
    if (forkSettled.status === 'rejected') {
      return new Error('Failed to fork session', { cause: forkSettled.reason })
    }
    return new Error('Failed to create the btw thread', {
      cause: threadSettled.status === 'rejected' ? threadSettled.reason : undefined,
    })
  }
  const thread = createdThread
  const channelId = sourceThread.parentId || sourceThread.id
  const sourceThreadLink = `<#${sourceThread.id}>`

  await Promise.all([
    // Kimaki re-selects the agent from its DB on every turn. Copy the fork
    // point agent too, or the fork switches to the default agent.
    copySessionPreferences({
      sourceSessionId: sessionId,
      targetSessionId: forkedSession.id,
      forkedAgent: forkedSession.agent,
      channelId,
      appId,
      getClient: getClientResult,
      directory: sdkDirectory,
    }),
    // DB mapping must complete before dispatch so the thread is routable
    (async () => {
      await setThreadSession(thread.id, forkedSession.id)
      const sourceWorkspace = await getThreadWorktreeOrWorkspace(sourceThread.id)
      if (sourceWorkspace?.status !== 'ready' || !sourceWorkspace.workspace_directory) {
        return
      }
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
    })(),
    thread.members.add(userId).catch((error) => {
      logger.warn('Could not add fork member:', error)
    }),
    sendThreadMessage(
      thread,
      `Reusing context from ${sourceThreadLink} to answer prompt...\n${prompt}`,
    ),
  ])

  const routeMs = Date.now() - routeStartedAt
  logger.log(
    `Created btw fork session ${forkedSession.id} in thread ${thread.id} from source thread ${sourceThread.id} (session ${sessionId}), system prompt ${copiedSystem ? 'reused' : 'regenerated'}`,
  )
  logger.log(
    `[BTW TIMING] ${forkedSession.id} init=${initMs}ms fork=${forkMs}ms threadCreate=${threadMs}ms copyPrefs=${copyMs}ms route=${routeMs}ms total=${Date.now() - startedAt}ms`,
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
    // Forks inherit the parent title, so OpenCode never auto-titles them.
    `This fork still has the parent session title. Rename it to a short title (max ~6 words) for the side question:`,
    `kimaki session title '<title>' --session ${forkedSession.id}`,
    `No btw: prefix, Kimaki keeps it on the Discord thread.`,
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
  // Not awaited: the caller confirms in the source thread right away while the
  // runtime resolves preferences and dispatches. Failures are reported in the fork.
  void runtime.enqueueIncoming({
    prompt: wrappedPrompt,
    agent,
    images,
    userId,
    username,
    appId,
    mode: 'opencode',
  }).then(() => {
    logger.log(`[BTW TIMING] ${forkedSession.id} promptAccepted=${Date.now() - startedAt}ms`)
  }, async (error) => {
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

  const { prompt, forceQueue } = extractQueueSuffix(command.options.getString('prompt', true))
  if (!prompt.trim()) {
    await command.reply({ content: 'Write a question to fork', flags: MessageFlags.Ephemeral })
    return
  }

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
    if (forceQueue) {
      if (!await getThreadSession(threadChannel.id)) {
        await command.editReply('No active session in this thread. Start a session, then retry /btw.')
        return
      }
      const runtime = getOrCreateRuntime({
        threadId: threadChannel.id,
        thread: threadChannel,
        projectDirectory,
        sdkDirectory: workingDirectory,
        channelId: threadChannel.parentId || threadChannel.id,
        appId,
      })
      const queued = await runtime.enqueueIncoming({
        prompt,
        queuedAction: 'btw',
        userId: command.user.id,
        username: command.user.displayName,
        appId,
        mode: 'local-queue',
      })
      await command.editReply(queued.queued
        ? `Btw fork queued at position ${queued.position}. It will start after the earlier prompts finish.`
        : 'Btw fork started. The new thread will appear shortly.')
      return
    }
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
