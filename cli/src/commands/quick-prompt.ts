import {
  ChannelType,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type ThreadChannel,
} from 'discord.js'
import { getChannelWorktreesEnabled } from '../database.js'
import {
  getKimakiMetadata,
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { store } from '../store.js'
import { isGitRepositoryRoot } from '../worktrees.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  createWorktreeInBackground,
  formatAutoWorktreeName,
  worktreeCreatingMessage,
} from './new-worktree.js'
import { WORKTREE_PREFIX } from './merge-worktree.js'

const quickPromptLogger = createLogger(LogPrefix.AGENT)

export async function handleQuickPrompt({
  command,
  appId,
  prompt,
  displayLabel,
  confirmationLabel,
  threadReason,
  agent,
  model,
  variant,
}: {
  command: ChatInputCommandInteraction
  appId: string
  prompt: string
  displayLabel: string
  confirmationLabel: string
  threadReason: string
  agent?: string
  model?: string
  variant?: string | null
}): Promise<void> {
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
  const displayText = `${prompt.slice(0, 1000)}${prompt.length > 1000 ? '...' : ''}`

  if (isThread) {
    const thread = channel as ThreadChannel
    const resolved = await resolveWorkingDirectory({ channel: thread })
    if (!resolved) {
      await command.reply({
        content: 'Could not determine project directory for this channel',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const runtime = getOrCreateRuntime({
      threadId: thread.id,
      thread,
      projectDirectory: resolved.projectDirectory,
      sdkDirectory: resolved.workingDirectory,
      channelId: thread.parentId || thread.id,
      appId,
    })
    await command.reply({
      content: `» **${command.user.displayName}** (${displayLabel}): ${displayText}`,
      flags: SILENT_MESSAGE_FLAGS,
    })
    await runtime.enqueueIncoming({
      prompt,
      userId: command.user.id,
      username: command.user.displayName,
      agent,
      model,
      variant,
      appId,
      mode: 'opencode',
    })
    return
  }

  if (channel.type !== ChannelType.GuildText) {
    await command.reply({
      content: 'This command can only be used in text channels or threads',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const metadata = await getKimakiMetadata(channel)
  const projectDirectory = metadata.projectDirectory
  if (!projectDirectory) {
    await command.reply({
      content: 'This channel is not configured with a project directory',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await command.deferReply()
  const wantsWorktrees =
    store.getState().useWorktrees || (await getChannelWorktreesEnabled(channel.id))
  const shouldUseWorktrees = wantsWorktrees && (await isGitRepositoryRoot(projectDirectory))
  if (wantsWorktrees && !shouldUseWorktrees) {
    quickPromptLogger.warn(
      `[WORKTREE] Skipping automatic worktree for non-git project directory: ${projectDirectory}`,
    )
  }

  const baseThreadName = prompt.slice(0, 80)
  const threadName = shouldUseWorktrees ? `${WORKTREE_PREFIX}${baseThreadName}` : baseThreadName
  const starterMessage = await channel.send({
    content: `» **${command.user.displayName}** (${displayLabel}): ${displayText}`,
    flags: SILENT_MESSAGE_FLAGS,
  })
  const thread = await starterMessage.startThread({
    name: threadName.slice(0, 80),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: threadReason,
  })
  await thread.members.add(command.user.id)

  let worktreePromise: Promise<string | Error> | undefined
  if (shouldUseWorktrees) {
    const worktreeName = formatAutoWorktreeName(baseThreadName.slice(0, 50))
    quickPromptLogger.log(`[WORKTREE] Creating worktree: ${worktreeName}`)
    const worktreeStatusMessage = await thread
      .send({
        content: worktreeCreatingMessage(worktreeName),
        flags: SILENT_MESSAGE_FLAGS,
      })
      .catch(() => undefined)
    worktreePromise = createWorktreeInBackground({
      thread,
      starterMessage: worktreeStatusMessage,
      worktreeName,
      projectDirectory,
      rest: command.client.rest,
    })
  }

  const worktreeResult = worktreePromise ? await worktreePromise : projectDirectory
  if (worktreeResult instanceof Error) {
    await command.editReply(`Worktree creation failed: ${worktreeResult.message}`)
    return
  }

  await command.editReply(`Sent with ${confirmationLabel} in ${thread.toString()}`).catch(() => {
    quickPromptLogger.warn('[COMMAND] Failed to edit quick-prompt reply, continuing session')
  })

  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory,
    sdkDirectory: worktreeResult,
    channelId: channel.id,
    appId,
  })
  await runtime.enqueueIncoming({
    prompt,
    userId: command.user.id,
    username: command.user.displayName,
    agent,
    model,
    variant,
    appId,
    mode: 'opencode',
  })
}
