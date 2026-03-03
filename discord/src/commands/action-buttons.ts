// Action button tool handler - Shows Discord buttons for quick model actions.
// Used by the kimaki_action_buttons tool to render up to 3 buttons and route
// button clicks back into the session as a new user message.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ThreadChannel,
} from 'discord.js'
import crypto from 'node:crypto'
import { getThreadSession } from '../database.js'
import {
  NOTIFY_MESSAGE_FLAGS,
  resolveWorkingDirectory,
  sendThreadMessage,
} from '../discord-utils.js'
import { createLogger } from '../logger.js'
import { notifyError } from '../sentry.js'
import {
  getOrCreateRuntime,
} from '../session-handler/thread-session-runtime.js'

const logger = createLogger('ACT_BTN')
const PENDING_TTL_MS = 24 * 60 * 60 * 1000

export type ActionButtonColor = 'white' | 'blue' | 'green' | 'red'

export type ActionButtonOption = {
  label: string
  color?: ActionButtonColor
}

export type ActionButtonsRequest = {
  sessionId: string
  threadId: string
  directory: string
  buttons: ActionButtonOption[]
}

type PendingActionButtonsContext = {
  sessionId: string
  directory: string
  thread: ThreadChannel
  buttons: ActionButtonOption[]
  contextHash: string
  messageId?: string
  resolved: boolean
  timer: ReturnType<typeof setTimeout>
}

export const pendingActionButtonContexts = new Map<
  string,
  PendingActionButtonsContext
>()
const pendingActionButtonRequests = new Map<string, ActionButtonsRequest>()
const pendingActionButtonRequestWaiters = new Map<
  string,
  (request: ActionButtonsRequest) => void
>()

export function queueActionButtonsRequest(request: ActionButtonsRequest): void {
  pendingActionButtonRequests.set(request.sessionId, request)
  const waiter = pendingActionButtonRequestWaiters.get(request.sessionId)
  if (!waiter) {
    return
  }
  pendingActionButtonRequestWaiters.delete(request.sessionId)
  waiter(request)
}

export async function waitForQueuedActionButtonsRequest({
  sessionId,
  timeoutMs,
}: {
  sessionId: string
  timeoutMs: number
}): Promise<ActionButtonsRequest | undefined> {
  const queued = pendingActionButtonRequests.get(sessionId)
  if (queued) {
    pendingActionButtonRequests.delete(sessionId)
    return queued
  }

  return await new Promise<ActionButtonsRequest | undefined>((resolve) => {
    const timeout = setTimeout(() => {
      const currentWaiter = pendingActionButtonRequestWaiters.get(sessionId)
      if (!currentWaiter || currentWaiter !== onRequest) {
        return
      }
      pendingActionButtonRequestWaiters.delete(sessionId)
      resolve(undefined)
    }, timeoutMs)

    const onRequest = (request: ActionButtonsRequest) => {
      clearTimeout(timeout)
      pendingActionButtonRequests.delete(sessionId)
      resolve(request)
    }

    pendingActionButtonRequestWaiters.set(sessionId, onRequest)
  })
}

function toButtonStyle(color?: ActionButtonColor): ButtonStyle {
  if (color === 'blue') {
    return ButtonStyle.Primary
  }
  if (color === 'green') {
    return ButtonStyle.Success
  }
  if (color === 'red') {
    return ButtonStyle.Danger
  }
  return ButtonStyle.Secondary
}

function resolveContext(context: PendingActionButtonsContext): boolean {
  if (context.resolved) {
    return false
  }
  context.resolved = true
  clearTimeout(context.timer)
  pendingActionButtonContexts.delete(context.contextHash)
  return true
}

function updateButtonMessage({
  context,
  status,
}: {
  context: PendingActionButtonsContext
  status: string
}): void {
  if (!context.messageId) {
    return
  }
  context.thread.messages
    .fetch(context.messageId)
    .then((message) => {
      return message.edit({
        content: `**Action Required**\n${status}`,
        components: [],
      })
    })
    .catch(() => {})
}

async function sendClickedActionToModel({
  interaction,
  thread,
  prompt,
}: {
  interaction: ButtonInteraction
  thread: ThreadChannel
  prompt: string
}): Promise<void> {
  const resolved = await resolveWorkingDirectory({ channel: thread })
  if (!resolved) {
    throw new Error('Could not resolve project directory for thread')
  }

  const username = interaction.user.globalName || interaction.user.username

  // Action button clicks use opencode queue mode.
  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory: resolved.projectDirectory,
    sdkDirectory: resolved.workingDirectory,
    channelId: thread.parentId || thread.id,
    appId: resolved.channelAppId,
  })
  await runtime.enqueueIncoming({
    prompt,
    userId: interaction.user.id,
    username,
    appId: resolved.channelAppId,
    mode: 'opencode',
  })
}

export async function showActionButtons({
  thread,
  sessionId,
  directory,
  buttons,
}: {
  thread: ThreadChannel
  sessionId: string
  directory: string
  buttons: ActionButtonOption[]
}): Promise<void> {
  const safeButtons = buttons
    .slice(0, 3)
    .map((button) => {
      return {
        label: button.label.trim().slice(0, 80),
        color: button.color,
      }
    })
    .filter((button) => {
      return button.label.length > 0
    })

  if (safeButtons.length === 0) {
    throw new Error('No valid buttons to display')
  }

  const contextHash = crypto.randomBytes(8).toString('hex')
  const timer = setTimeout(() => {
    const current = pendingActionButtonContexts.get(contextHash)
    if (!current || current.resolved) {
      return
    }
    resolveContext(current)
    updateButtonMessage({ context: current, status: '_Expired_' })
  }, PENDING_TTL_MS)

  const context: PendingActionButtonsContext = {
    sessionId,
    directory,
    thread,
    buttons: safeButtons,
    contextHash,
    resolved: false,
    timer,
  }

  pendingActionButtonContexts.set(contextHash, context)

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...safeButtons.map((button, index) => {
      return new ButtonBuilder()
        .setCustomId(`action_button:${contextHash}:${index}`)
        .setLabel(button.label)
        .setStyle(toButtonStyle(button.color))
    }),
  )

  try {
    const message = await thread.send({
      content: '**Action Required**',
      components: [row],
      flags: NOTIFY_MESSAGE_FLAGS,
    })

    context.messageId = message.id
    logger.log(
      `Showed ${safeButtons.length} action button(s) for session ${sessionId}`,
    )
  } catch (error) {
    clearTimeout(timer)
    pendingActionButtonContexts.delete(contextHash)
    throw new Error('Failed to send action buttons', { cause: error })
  }
}

export async function handleActionButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('action_button:')) {
    return
  }

  const [, contextHash, indexPart] = customId.split(':')
  if (!contextHash || !indexPart) {
    await interaction.reply({
      content: 'Invalid action button.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const context = pendingActionButtonContexts.get(contextHash)
  if (!context || context.resolved) {
    await interaction.reply({
      content: 'This action is no longer available.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const buttonIndex = Number.parseInt(indexPart, 10)
  const button = context.buttons[buttonIndex]
  if (!button) {
    await interaction.reply({
      content: 'This action is no longer available.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferUpdate()
  const claimed = resolveContext(context)
  if (!claimed) {
    return
  }

  const thread = interaction.channel
  if (!thread?.isThread()) {
    logger.warn('[ACTION] Button clicked outside thread channel')
    await interaction.editReply({
      content: '**Action Required**\n_This action is no longer available._',
      components: [],
    })
    return
  }

  const currentSessionId = await getThreadSession(thread.id)
  if (!currentSessionId || currentSessionId !== context.sessionId) {
    await interaction.editReply({
      content: '**Action Required**\n_Expired due to session change._',
      components: [],
    })
    return
  }

  await interaction.editReply({
    content: `**Action Required**\n_Selected: ${button.label}_`,
    components: [],
  })

  const prompt = `User clicked: ${button.label}`

  try {
    await sendClickedActionToModel({
      interaction,
      thread,
      prompt,
    })
  } catch (error) {
    logger.error('[ACTION] Failed to send click to model:', error)
    void notifyError(error, 'Action button click send to model failed')
    await sendThreadMessage(
      thread,
      `Failed to send action click: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Dismiss pending action buttons for a thread (e.g. user sent a new message).
 * Removes buttons from the message and cleans up context.
 */
export function cancelPendingActionButtons(threadId: string): boolean {
  for (const [, ctx] of pendingActionButtonContexts) {
    if (ctx.thread.id !== threadId) {
      continue
    }
    if (!resolveContext(ctx)) {
      continue
    }
    updateButtonMessage({ context: ctx, status: '_Buttons dismissed._' })
    return true
  }
  return false
}
