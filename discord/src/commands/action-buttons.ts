// Action button tool handler - Shows Discord buttons for quick model actions.
// Used by the kimaki_action_buttons tool to render up to 3 buttons and route
// button clicks back into the session as a new user message.

import { MessageFlags, type ThreadChannel } from 'discord.js'
import crypto from 'node:crypto'
import { getThreadSession } from '../database.js'
import {
  NOTIFY_MESSAGE_FLAGS,
  resolveWorkingDirectory,
} from '../discord-utils.js'
import { createLogger } from '../logger.js'
import { notifyError } from '../sentry.js'
import {
  getDefaultRuntimeAdapter,
  getOrCreateRuntime,
} from '../session-handler/thread-session-runtime.js'
import { platformThreadFromDiscord } from '../platform/platform-value.js'
import type { ButtonEvent, PlatformThread, UiButtonStyle } from '../platform/types.js'

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
  thread: PlatformThread
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

function toButtonStyle(color?: ActionButtonColor): UiButtonStyle {
  if (color === 'blue') {
    return 'primary'
  }
  if (color === 'green') {
    return 'success'
  }
  if (color === 'red') {
    return 'danger'
  }
  return 'secondary'
}

function normalizeThread(thread: PlatformThread | ThreadChannel): PlatformThread {
  if ('raw' in thread) {
    return thread
  }
  return platformThreadFromDiscord(thread)
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
  const adapter = getDefaultRuntimeAdapter()
  if (!adapter) {
    return
  }
  const threadTarget = {
    channelId: context.thread.parentId || context.thread.id,
    threadId: context.thread.id,
  }
  void adapter.updateMessage(threadTarget, context.messageId, {
    markdown: `**Action Required**\n${status}`,
  }).catch(() => {})
}

async function sendClickedActionToModel({
  interaction,
  thread,
  prompt,
}: {
  interaction: ButtonEvent
  thread: PlatformThread | ThreadChannel
  prompt: string
}): Promise<void> {
  const normalizedThread = normalizeThread(thread)
  const resolved = await resolveWorkingDirectory({ channel: normalizedThread })
  if (!resolved) {
    throw new Error('Could not resolve project directory for thread')
  }

  const username = interaction.user.globalName || interaction.user.username

  // Action button clicks use opencode queue mode.
  const runtime = getOrCreateRuntime({
    threadId: normalizedThread.id,
    thread: normalizedThread,
    projectDirectory: resolved.projectDirectory,
    sdkDirectory: resolved.workingDirectory,
    channelId: normalizedThread.parentId || normalizedThread.id,
  })
  await runtime.enqueueIncoming({
    prompt,
    userId: interaction.user.id,
    username,
    mode: 'opencode',
  })
}

export async function showActionButtons({
  thread,
  sessionId,
  directory,
  buttons,
}: {
  thread: PlatformThread | ThreadChannel
  sessionId: string
  directory: string
  buttons: ActionButtonOption[]
}): Promise<void> {
  const normalizedThread = normalizeThread(thread)
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
    thread: normalizedThread,
    buttons: safeButtons,
    contextHash,
    resolved: false,
    timer,
  }

  pendingActionButtonContexts.set(contextHash, context)
  const adapter = getDefaultRuntimeAdapter()
  if (!adapter) {
    clearTimeout(timer)
    pendingActionButtonContexts.delete(contextHash)
    throw new Error('No runtime adapter configured')
  }
  const threadTarget = {
    channelId: normalizedThread.parentId || normalizedThread.id,
    threadId: normalizedThread.id,
  }

  try {
    const message = await adapter.sendMessage(threadTarget, {
      markdown: '**Action Required**',
      flags: NOTIFY_MESSAGE_FLAGS,
      buttons: safeButtons.map((button, index) => {
        return {
          id: `action_button:${contextHash}:${index}`,
          label: button.label,
          style: toButtonStyle(button.color),
        }
      }),
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
  interaction: ButtonEvent,
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
    const adapter = getDefaultRuntimeAdapter()
    if (!adapter) {
      return
    }
    await adapter.sendMessage(
      {
        channelId: thread.parentId || thread.id,
        threadId: thread.id,
      },
      {
        markdown: `Failed to send action click: ${error instanceof Error ? error.message : String(error)}`,
      },
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
