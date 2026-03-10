// User-defined OpenCode command handler.
// Handles slash commands that map to user-configured commands in opencode.json.

import type { CommandContext, CommandHandler } from './types.js'
import { PLATFORM_MESSAGE_FLAGS } from '../platform/message-flags.js'

import {
  getDefaultRuntimeAdapter,
  getOrCreateRuntime,
} from '../session-handler/thread-session-runtime.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { getChannelDirectory, getThreadSession } from '../database.js'
import { store } from '../store.js'
import fs from 'node:fs'
import type { PlatformThread } from '../platform/types.js'
import { isTextChannel, isThreadChannel } from './channel-ref.js'

const userCommandLogger = createLogger(LogPrefix.USER_CMD)

export const handleUserCommand: CommandHandler = async ({
  command,
  appId,
}: CommandContext) => {
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

  userCommandLogger.log(
    `Executing /${commandName} (from /${discordCommandName}) argsLength=${args.length}`,
  )

  const channel = command.channel

  userCommandLogger.log(
    `Channel info: kind=${channel?.kind}, id=${channel?.id}, isNull=${channel === null}`,
  )

  const isThread = isThreadChannel(channel)
  const isText = isTextChannel(channel)

  if (!channel || (!isText && !isThread)) {
    await command.reply({
      content: 'This command can only be used in text channels or threads',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  let projectDirectory: string | undefined
  let textChannelId: string | null = null
  let thread: PlatformThread | null = null

  if (isThread) {
    // Running in an existing thread - get project directory from parent channel
    thread = channel
    textChannelId = thread.parentId || null

    // Verify this thread has an existing session
    const sessionId = await getThreadSession(thread.id)

    if (!sessionId) {
      await command.reply({
        content:
          'This thread does not have an active session. Use this command in a project channel to create a new thread.',
        flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
      })
      return
    }

    if (textChannelId) {
      const channelConfig = await getChannelDirectory(textChannelId)
      projectDirectory = channelConfig?.directory
    }
  } else {
    // Running in a text channel - will create a new thread
    textChannelId = channel.id
    const channelConfig = await getChannelDirectory(channel.id)
    projectDirectory = channelConfig?.directory
  }

  if (!projectDirectory) {
    await command.reply({
      content: 'This channel is not configured with a project directory',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  if (!fs.existsSync(projectDirectory)) {
    await command.reply({
      content: `Directory does not exist: ${projectDirectory}`,
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  await command.deferReply({ ephemeral: false })

  try {
    // Use the dedicated session.command API instead of formatting as text prompt
    const commandPayload = { name: commandName, arguments: args }

    if (isThread && thread) {
      // Running in existing thread - just send the command
      await command.editReply(`Running /${commandName}...`)

      const runtime = getOrCreateRuntime({
        threadId: thread.id,
        thread,
        projectDirectory,
        sdkDirectory: projectDirectory,
        channelId: textChannelId || undefined,
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
    } else if (textChannelId) {
      // Running in text channel - create a new thread
      const adapter = getDefaultRuntimeAdapter()
      if (!adapter) {
        throw new Error('No runtime adapter configured')
      }
      const channelTarget = {
        channelId: textChannelId,
      }
      const starterMessage = await adapter.conversation(channelTarget).send({
        markdown: `**/${commandName}**`,
        flags: SILENT_MESSAGE_FLAGS,
      })

      const threadName = `/${commandName}`
      const { thread: newThread, target: threadTarget } = await adapter
        .conversation(channelTarget)
        .message(starterMessage.id)
        .then((messageHandle) => {
          return messageHandle.startThread({
            name: threadName.slice(0, 100),
            autoArchiveDuration: 1440,
            reason: `OpenCode command: ${commandName}`,
          })
        })

      const threadHandle = await adapter.thread({
        threadId: threadTarget.threadId,
        parentId: newThread.parentId,
      })
      if (!threadHandle) {
        throw new Error(`Thread not found: ${threadTarget.threadId}`)
      }
      await threadHandle.addMember(command.user.id)

      if (args) {
        const argsPreview =
          args.length > 1800 ? `${args.slice(0, 1800)}\n... truncated` : args
        await adapter.conversation({
          channelId: newThread.parentId || newThread.id,
          threadId: newThread.id,
        }).send({ markdown: `Args: ${argsPreview}` })
      }

      const threadReference = threadHandle.reference()
      await command.editReply(
        `Started /${commandName} in ${threadReference}`,
      )

      const runtime = getOrCreateRuntime({
        threadId: newThread.id,
        thread: newThread,
        projectDirectory,
        sdkDirectory: projectDirectory,
        channelId: textChannelId,
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
        flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
      })
    }
  }
}
