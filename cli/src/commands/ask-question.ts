// AskUserQuestion tool handler - Shows Discord dropdowns for AI questions.
// When the AI uses the AskUserQuestion tool, this module renders dropdowns
// for each question and collects user responses.

import {
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  type ThreadChannel,
  MessageFlags,
} from 'discord.js'
import crypto from 'node:crypto'
import { sendThreadMessage, NOTIFY_MESSAGE_FLAGS, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { getOpencodeClient } from '../opencode.js'
import { DiscordOperationError } from '../errors.js'
import { createLogger, LogPrefix } from '../logger.js'
import { QUEUE_PREFIX } from '../message-formatting.js'
import { getRuntime } from '../session-handler/thread-session-runtime.js'

const logger = createLogger(LogPrefix.ASK_QUESTION)

// Schema matching the question tool input
export type AskUserQuestionInput = {
  questions: Array<{
    question: string
    header: string // max 12 chars
    options: Array<{
      label: string
      description: string
    }>
    multiple?: boolean // optional, defaults to false
  }>
}

export type CancelQuestionResult = 'no-pending' | 'replied' | 'reply-failed'

type PendingQuestionContext = {
  sessionId: string
  directory: string
  thread: ThreadChannel
  requestId: string // OpenCode question request ID for replying
  questions: AskUserQuestionInput['questions']
  answers: Record<number, string[]> // questionIndex -> selected labels
  totalQuestions: number
  contextHash: string

}

// Store pending question contexts by hash.
// No TTL on purpose: a question can only be answered by the user, so expiring it
// could only abort the run. Cleanup happens on answer, on a new user message, on
// abort (abortActiveRunInternal), and on thread dispose.
export const pendingQuestionContexts = new Map<string, PendingQuestionContext>()

export function areAllQuestionsAnswered({
  totalQuestions,
  answers,
}: {
  totalQuestions: number
  answers: Record<number, string[]>
}): boolean {
  for (let i = 0; i < totalQuestions; i++) {
    if (!answers[i]) {
      return false
    }
  }
  return true
}

export function findPendingQuestionContextForRequest({
  threadId,
  requestId,
}: {
  threadId: string
  requestId: string
}): { contextHash: string; context: PendingQuestionContext } | null {
  for (const [contextHash, context] of pendingQuestionContexts) {
    if (context.thread.id !== threadId) {
      continue
    }
    if (context.requestId !== requestId) {
      continue
    }
    return { contextHash, context }
  }
  return null
}

export function deletePendingQuestionContextsForRequest({
  threadId,
  requestId,
}: {
  threadId: string
  requestId: string
}): number {
  const matchingContextHashes = [...pendingQuestionContexts.entries()]
    .filter(([, context]) => {
      return context.thread.id === threadId && context.requestId === requestId
    })
    .map(([contextHash]) => {
      return contextHash
    })

  matchingContextHashes.map((contextHash) => {
    pendingQuestionContexts.delete(contextHash)
    return contextHash
  })

  return matchingContextHashes.length
}

export function hasPendingQuestionForThread(threadId: string): boolean {
  return [...pendingQuestionContexts.values()].some((ctx) => {
    return ctx.thread.id === threadId
  })
}

/**
 * Show dropdown menus for question tool input.
 * Sends one message per question with the dropdown directly under the question text.
 */
export async function showAskUserQuestionDropdowns({
  thread,
  sessionId,
  directory,
  requestId,
  input,
  silent,
}: {
  thread: ThreadChannel
  sessionId: string
  directory: string
  requestId: string // OpenCode question request ID
  input: AskUserQuestionInput
  /** Suppress notification when queue has pending items */
  silent?: boolean
}): Promise<void> {
  const existingPending = findPendingQuestionContextForRequest({
    threadId: thread.id,
    requestId,
  })
  if (existingPending) {
    logger.log(
      `Deduped question ${requestId} for thread ${thread.id} (existing context ${existingPending.contextHash})`,
    )
    return
  }

  const contextHash = crypto.randomBytes(8).toString('hex')

  const context: PendingQuestionContext = {
    sessionId,
    directory,
    thread,
    requestId,
    questions: input.questions,
    answers: {},
    totalQuestions: input.questions.length,
    contextHash,

  }

  pendingQuestionContexts.set(contextHash, context)

  // Send one message per question with its dropdown directly underneath
  for (let i = 0; i < input.questions.length; i++) {
    const q = input.questions[i]!

    // Map options to Discord select menu options
    // Discord max: 25 options per select menu
    const options = [
      ...q.options.slice(0, 24).map((opt, optIdx) => ({
        label: opt.label.slice(0, 100),
        value: `${optIdx}`,
        description: opt.description.slice(0, 100),
      })),
      {
        label: 'Other',
        value: 'other',
        description: 'Provide a custom answer in chat',
      },
    ]

    const placeholder =
      options.find((x) => x.label)?.label || 'Select an option'
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`ask_question:${contextHash}:${i}`)
      .setPlaceholder(placeholder)
      .addOptions(options)

    // Enable multi-select if the question supports it
    if (q.multiple) {
      selectMenu.setMinValues(1)
      selectMenu.setMaxValues(options.length)
    }

    const actionRow =
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

    const sendResult = await thread.send({
      content: `**${(q.header || '').slice(0, 200)}**\n${q.question.slice(0, 1700)}`,
      components: [actionRow],
      flags: silent ? SILENT_MESSAGE_FLAGS : NOTIFY_MESSAGE_FLAGS,
    }).catch((e) => new DiscordOperationError({ operation: 'sendQuestionDropdown', cause: e }))
    // Without a visible dropdown the user can never answer, and there is no TTL
    // to rescue the run, so drop the context and abort so OpenCode unblocks.
    if (sendResult instanceof Error) {
      logger.error('Failed to send question dropdown:', sendResult)
      deletePendingQuestionContextsForRequest({ threadId: thread.id, requestId })
      const client = getOpencodeClient(directory)
      if (client) {
        await client.session.abort({ sessionID: sessionId }).catch((error) => {
          logger.error('Failed to abort session after question send failure:', error)
        })
      }
      return
    }
  }

  logger.log(
    `Showed ${input.questions.length} question dropdown(s) for session ${sessionId}`,
  )
}

/**
 * Handle dropdown selection for AskUserQuestion.
 */
export async function handleAskQuestionSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('ask_question:')) {
    return
  }

  const parts = customId.split(':')
  const contextHash = parts[1]
  const questionIndex = parseInt(parts[2]!, 10)

  if (!contextHash) {
    await interaction.reply({
      content: 'Invalid selection.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const context = pendingQuestionContexts.get(contextHash)

  if (!context) {
    await interaction.reply({
      content: 'This question has expired. Please ask the AI again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferUpdate()

  const selectedValues = interaction.values
  const question = context.questions[questionIndex]

  if (!question) {
    logger.error(`Question index ${questionIndex} not found in context`)
    return
  }

  if (context.answers[questionIndex]) {
    logger.log(
      `Ignored duplicate answer for question ${context.requestId} index ${questionIndex}`,
    )
    return
  }

  // Check if "other" was selected
  if (selectedValues.includes('other')) {
    // User wants to provide custom answer
    // For now, mark as "Other" - they can type in chat
    context.answers[questionIndex] = ['Other (please type your answer in chat)']
  } else {
    // Map value indices back to option labels
    context.answers[questionIndex] = selectedValues.map((v) => {
      const optIdx = parseInt(v, 10)
      return question.options[optIdx]?.label || `Option ${optIdx + 1}`
    })
  }

  // Update this question's message: show answer and remove dropdown
  const answeredText = context.answers[questionIndex]!.join(', ')
  await interaction.editReply({
    content: `**${question.header}**\n${question.question}\n✓ _${answeredText}_`,
    components: [], // Remove the dropdown
  })

  const username = interaction.user.globalName || interaction.user.username
  await sendThreadMessage(
    context.thread,
    `${QUEUE_PREFIX}**${username}:** ${answeredText}`,
  )

  // Check if all questions are answered. Claim the context synchronously
  // (delete before awaiting submit) so two concurrent final selections for a
  // multi-question tool cannot both submit and double-resume the session.
  if (
    areAllQuestionsAnswered(context)
    && pendingQuestionContexts.get(contextHash) === context
  ) {
    deletePendingQuestionContextsForRequest({
      threadId: context.thread.id,
      requestId: context.requestId,
    })
    await submitQuestionAnswers(context)
  }
}

/**
 * Format collected answers as a plain-text summary the model can read when
 * the run is resumed after an abort (e.g. `"Which option?"="Alpha"`).
 *
 * Known limitation: if the user had queued items via /queue during the pending
 * question AND aborted the run from another opencode client, the first queued
 * item may have already been handed off to opencode and can lose its ordering
 * on resume. That rare combination needs a queue-handoff redesign; the common
 * (no-queue) abort case is handled correctly.
 */
function formatQuestionAnswersText(context: PendingQuestionContext): string {
  const parts = context.questions.map((q, i) => {
    const answer = (context.answers[i] || []).join(', ') || 'Unanswered'
    return `"${q.question}"="${answer}"`
  })
  return `Answers to your previous questions: ${parts.join(', ')}`
}

/** Resume the session by feeding the answers back as a new user prompt. */
async function resumeSessionWithAnswers(
  context: PendingQuestionContext,
): Promise<void> {
  const runtime = getRuntime(context.thread.id)
  const resumed = await runtime?.resumeWithText({
    text: formatQuestionAnswersText(context),
  })
  if (!resumed) {
    await sendThreadMessage(
      context.thread,
      '✗ Failed to submit answers: session is no longer active',
    )
  }
}

/**
 * Submit all collected answers back to the OpenCode session.
 *
 * The decision is based on whether the session still has a live run:
 *
 * - Busy: a live run is parked on the question. Reply so it continues.
 * - Idle: the run was aborted (from this or another opencode client). Replying
 *   would resolve a dead run and the session would never continue, so resume it
 *   with the answers as a fresh prompt instead.
 *
 * Note: `question.list` is not a reliable signal here. After an abort the
 * question request can stay in the pending list but orphaned (no run awaiting
 * it), so a reply would succeed yet the session would still not continue. The
 * session busy state, derived from the event stream, is the accurate signal.
 * The reply `.error` check is a safety net for the case where the request was
 * actually removed while the session still looked busy.
 */
async function submitQuestionAnswers(
  context: PendingQuestionContext,
): Promise<void> {
  const client = getOpencodeClient(context.directory)
  if (!client) {
    logger.error('OpenCode server not found for directory')
    return
  }

  const runtime = getRuntime(context.thread.id)

  if (runtime && !runtime.isBusy()) {
    logger.log(
      `Session ${context.sessionId} idle; resuming with answers for question ${context.requestId}`,
    )
    await resumeSessionWithAnswers(context)
    return
  }

  const answers = context.questions.map((_, i) => {
    return context.answers[i] || []
  })

  // throwOnError is off on this client, so failures come back in `.error`.
  const replyResult = await client.question
    .reply({ requestID: context.requestId, directory: context.directory, answers })
    .catch((error) => ({ error }))

  if (!replyResult.error) {
    logger.log(
      `Submitted answers for question ${context.requestId} in session ${context.sessionId}`,
    )
    return
  }

  // Reply failed (the request was removed while the session still looked busy).
  // Resume so the answer still reaches the model.
  logger.log(
    `Reply failed for question ${context.requestId}; resuming session ${context.sessionId} with answers`,
  )
  await resumeSessionWithAnswers(context)
}

/**
 * Check if a tool part is an AskUserQuestion tool.
 * Returns the parsed input if valid, null otherwise.
 */
export function parseAskUserQuestionTool(part: {
  type: string
  tool?: string
  state?: { input?: AskUserQuestionInput }
}): AskUserQuestionInput | null {
  if (part.type !== 'tool') {
    return null
  }

  // Check for the tool name (case-insensitive)
  const toolName = part.tool?.toLowerCase()
  if (toolName !== 'question') {
    return null
  }

  const input = part.state?.input

  if (
    !input?.questions ||
    !Array.isArray(input.questions) ||
    input.questions.length === 0
  ) {
    return null
  }

  // Validate structure
  for (const q of input.questions) {
    if (
      typeof q.question !== 'string' ||
      typeof q.header !== 'string' ||
      !Array.isArray(q.options) ||
      q.options.length < 2
    ) {
      return null
    }
  }

  return input
}

/**
 * Cancel a pending question for a thread.
 *
 * Two modes depending on whether `userMessage` is provided:
 *
 * - `cancelPendingQuestion(threadId)` — cleanup only. Removes the context
 *   without replying to OpenCode. Use when aborting the blocked session
 *   separately (e.g. voice/attachment messages whose content needs
 *   transcription first). Returns 'no-pending' in both "found+cleaned" and
 *   "nothing found" cases.
 *
 * - `cancelPendingQuestion(threadId, text)` — reply path. Sends the text as
 *   the tool answer so the model sees the user's response. The caller should
 *   NOT also enqueue the message as a new prompt.
 *   Returns 'replied' on success, 'reply-failed' if the reply call fails
 *   (context kept pending so the user can retry).
 */
export async function cancelPendingQuestion(
  threadId: string,
  userMessage?: string,
): Promise<CancelQuestionResult> {
  // Find pending question for this thread
  let contextHash: string | undefined
  let context: PendingQuestionContext | undefined
  for (const [hash, ctx] of pendingQuestionContexts) {
    if (ctx.thread.id === threadId) {
      contextHash = hash
      context = ctx
      break
    }
  }

  if (!contextHash || !context) {
    return 'no-pending'
  }

  // undefined means teardown/cleanup — just remove context, don't reply.
  // The session is already being torn down or the caller wants to dismiss
  // the question without providing an answer (e.g. voice/attachment-only
  // messages where content needs transcription before it can be an answer).
  if (userMessage === undefined) {
    deletePendingQuestionContextsForRequest({
      threadId: context.thread.id,
      requestId: context.requestId,
    })
    return 'no-pending'
  }

  try {
    const client = getOpencodeClient(context.directory)
    if (!client) {
      throw new Error('OpenCode server not found for directory')
    }

    const answers = context.questions.map((_, i) => {
      return context.answers[i] || [userMessage]
    })

    await client.question.reply({
      requestID: context.requestId,
      directory: context.directory,
      answers,
    })

    logger.log(`Answered question ${context.requestId} with user message`)
  } catch (error) {
    logger.error('Failed to answer question:', error)
    // Keep context pending so the user can retry.
    // Caller should not consume the user message since reply failed.
    return 'reply-failed'
  }

  deletePendingQuestionContextsForRequest({
    threadId: context.thread.id,
    requestId: context.requestId,
  })
  return 'replied'
}
