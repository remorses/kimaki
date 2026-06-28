// User-defined OpenCode command handler.
// Handles slash commands that map to user-configured commands in opencode.json.

import type { CommandHandler } from './types.js'
import {
  ChannelType,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  getChannelDirectory,
  getChannelWorktreesEnabled,
  getThreadSession,
} from '../database.js'
import { store } from '../store.js'
import { isGitRepositoryRoot } from '../worktrees.js'
import {
  formatAutoWorktreeName,
  createWorktreeInBackground,
  worktreeCreatingMessage,
} from './new-worktree.js'
import { WORKTREE_PREFIX } from './merge-worktree.js'
import fs from 'node:fs'

const userCommandLogger = createLogger(LogPrefix.USER_CMD)
const DISCORD_MESSAGE_LIMIT = 2000
const DISCORD_THREAD_NAME_LIMIT = 100

export const handleUserCommand: CommandHandler = async ({
  command,
  appId,
}) => {
  const discordCommandName = command.commandName
  // Look up the original OpenCode command name from the mapping populated at registration.
  // The sanitized Discord name is lossy (e.g. foo:bar → foo-bar), so resolving from
  // the exact registered slash command name avoids collisions.
  const registered = store.getState().registeredUserCommands.find(
    (c) => c.discordCommandName === discordCommandName,
  )
  const fallbackBase = discordCommandName.replace(/-(cmd|skill|mcp-prompt)$/, '')
  const commandName = registered?.name || fallbackBase
  const args = command.options.getString('arguments') || ''
  const commandInvocation = args ? `/${commandName} ${args}` : `/${commandName}`
  const threadOpeningMessage =
    commandInvocation.length <= DISCORD_MESSAGE_LIMIT
      ? commandInvocation
      : `${commandInvocation.slice(0, DISCORD_MESSAGE_LIMIT - 14)}... truncated`

  userCommandLogger.log(
    `Executing /${commandName} (from /${discordCommandName}) argsLength=${args.length}`,
  )

  const channel = command.channel

  userCommandLogger.log(
    `Channel info: type=${channel?.type}, id=${channel?.id}, isNull=${channel === null}`,
  )

  const isThread =
    channel &&
    [
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ].includes(channel.type)

  const isTextChannel = channel?.type === ChannelType.GuildText

  if (!channel || (!isTextChannel && !isThread)) {
    await command.reply({
      content: 'This command can only be used in text channels or threads',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  let projectDirectory: string | undefined
  let textChannel: TextChannel | null = null
  let thread: ThreadChannel | null = null

  if (isThread) {
    // Running in an existing thread - get project directory from parent channel
    thread = channel as ThreadChannel
    textChannel = thread.parent as TextChannel | null

    // Verify this thread has an existing session
    const sessionId = await getThreadSession(thread.id)

    if (!sessionId) {
      await command.reply({
        content:
          'This thread does not have an active session. Use this command in a project channel to create a new thread.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    if (textChannel) {
      const channelConfig = await getChannelDirectory(textChannel.id)
      projectDirectory = channelConfig?.directory
    }
  } else {
    // Running in a text channel - will create a new thread
    textChannel = channel as TextChannel

    const channelConfig = await getChannelDirectory(textChannel.id)
    projectDirectory = channelConfig?.directory
  }

  if (!projectDirectory) {
    await command.reply({
      content: 'This channel is not configured with a project directory',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (!fs.existsSync(projectDirectory)) {
    await command.reply({
      content: `Directory does not exist: ${projectDirectory}`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await command.deferReply()

  try {
    // Use the dedicated session.command API instead of formatting as text prompt
    const commandPayload = { name: commandName, arguments: args }

    if (isThread && thread) {
      // Running in existing thread - just send the command
      await command.editReply(`Running ${commandInvocation}...`)

      const runtime = getOrCreateRuntime({
        threadId: thread.id,
        thread,
        projectDirectory,
        sdkDirectory: projectDirectory,
        channelId: textChannel?.id,
        appId,
      })
      await runtime.enqueueIncoming({
        prompt: '',
        userId: command.user.id,
        username: command.user.displayName,
        command: commandPayload,
        appId,
        mode: 'local-queue',
      })
    } else if (textChannel) {
      // Running in text channel - create a new thread

      // Check if worktrees should be enabled (CLI flag OR channel setting),
      // mirroring the logic in discord-bot.ts message handler.
      const wantsWorktrees =
        store.getState().useWorktrees ||
        (await getChannelWorktreesEnabled(textChannel.id))
      const shouldUseWorktrees =
        wantsWorktrees && (await isGitRepositoryRoot(projectDirectory))

      if (wantsWorktrees && !shouldUseWorktrees) {
        userCommandLogger.warn(
          `[WORKTREE] Skipping automatic worktree for non-git project directory: ${projectDirectory}`,
        )
      }

      const baseThreadName = commandInvocation.slice(0, DISCORD_THREAD_NAME_LIMIT)
      const threadName = shouldUseWorktrees
        ? `${WORKTREE_PREFIX}${baseThreadName}`
        : baseThreadName

      const starterMessage = await textChannel.send({
        content: threadOpeningMessage,
        flags: SILENT_MESSAGE_FLAGS,
      })

      const newThread = await starterMessage.startThread({
        name: threadName.slice(0, DISCORD_THREAD_NAME_LIMIT),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        reason: `OpenCode command: ${commandName}`,
      })

      // Add user to thread so it appears in their sidebar
      await newThread.members.add(command.user.id)

      // Create worktree in background if enabled, same as discord-bot.ts
      let worktreePromise: Promise<string | Error> | undefined
      if (shouldUseWorktrees) {
        const worktreeName = formatAutoWorktreeName(baseThreadName.slice(0, 50))
        userCommandLogger.log(`[WORKTREE] Creating worktree: ${worktreeName}`)

        const worktreeStatusMessage = await newThread
          .send({
            content: worktreeCreatingMessage(worktreeName),
            flags: SILENT_MESSAGE_FLAGS,
          })
          .catch(() => undefined)

        worktreePromise = createWorktreeInBackground({
          thread: newThread,
          starterMessage: worktreeStatusMessage,
          worktreeName,
          projectDirectory,
          rest: command.client.rest,
        })
      }

      const sessionDirectory = await (async () => {
        if (!worktreePromise) return projectDirectory
        const result = await worktreePromise
        if (result instanceof Error) return projectDirectory
        return result
      })()

      await command.editReply(
        `Started /${commandName} in ${newThread.toString()}`,
      )

      const runtime = getOrCreateRuntime({
        threadId: newThread.id,
        thread: newThread,
        projectDirectory,
        sdkDirectory: sessionDirectory,
        channelId: textChannel.id,
        appId,
      })
      await runtime.enqueueIncoming({
        prompt: '',
        userId: command.user.id,
        username: command.user.displayName,
        command: commandPayload,
        appId,
        mode: 'local-queue',
      })
    }
  } catch (error) {
    userCommandLogger.error(`Error executing /${commandName}:`, error)

    const errorMessage = error instanceof Error ? error.message : String(error)

    if (command.deferred) {
      await command.editReply({
        content: `Failed to execute /${commandName}: ${errorMessage}`,
      })
    } else {
      await command.reply({
        content: `Failed to execute /${commandName}: ${errorMessage}`,
        flags: MessageFlags.Ephemeral,
      })
    }
  }
}
