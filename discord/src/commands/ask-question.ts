// AskUserQuestion tool handler - Shows Discord dropdowns for AI questions.
// When the AI uses the AskUserQuestion tool, this module renders dropdowns
// for each question and collects user responses.

import {
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  type ThreadChannel,
} from 'discord.js'
import crypto from 'node:crypto'
import { sendThreadMessage, NOTIFY_MESSAGE_FLAGS } from '../discord-utils.js'
import { getOpencodeClientV2 } from '../opencode.js'
import { createLogger, LogPrefix } from '../logger.js'

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

type PendingQuestionContext = {
  sessionId: string
  directory: string
  thread: ThreadChannel
  requestId: string // OpenCode question request ID for replying
  questions: AskUserQuestionInput['questions']
  answers: Record<number, string[]> // questionIndex -> selected labels
  totalQuestions: number
  answeredCount: number
  contextHash: string
}

// Store pending question contexts by hash
export const pendingQuestionContexts = new Map<string, PendingQuestionContext>()

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
}: {
  thread: ThreadChannel
  sessionId: string
  directory: string
  requestId: string // OpenCode question request ID
  input: AskUserQuestionInput
}): Promise<void> {
  const contextHash = crypto.randomBytes(8).toString('hex')

  const context: PendingQuestionContext = {
    sessionId,
    directory,
    thread,
    requestId,
    questions: input.questions,
    answers: {},
    totalQuestions: input.questions.length,
    answeredCount: 0,
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

    const placeholder = options.find((x) => x.label)?.label || 'Select an option'
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`ask_question:${contextHash}:${i}`)
      .setPlaceholder(placeholder)
      .addOptions(options)

    // Enable multi-select if the question supports it
    if (q.multiple) {
      selectMenu.setMinValues(1)
      selectMenu.setMaxValues(options.length)
    }

    const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

    await thread.send({
      content: `**${q.header}**\n${q.question}`,
      components: [actionRow],
      flags: NOTIFY_MESSAGE_FLAGS,
    })
  }

  logger.log(`Showed ${input.questions.length} question dropdown(s) for session ${sessionId}`)
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
      ephemeral: true,
    })
    return
  }

  const context = pendingQuestionContexts.get(contextHash)

  if (!context) {
    await interaction.reply({
      content: 'This question has expired. Please ask the AI again.',
      ephemeral: true,
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

  context.answeredCount++

  // Update this question's message: show answer and remove dropdown
  const answeredText = context.answers[questionIndex]!.join(', ')
  await interaction.editReply({
    content: `**${question.header}**\n${question.question}\n✓ _${answeredText}_`,
    components: [], // Remove the dropdown
  })

  // Check if all questions are answered
  if (context.answeredCount >= context.totalQuestions) {
    // All questions answered - send result back to session
    await submitQuestionAnswers(context)
    pendingQuestionContexts.delete(contextHash)
  }
}

/**
 * Submit all collected answers back to the OpenCode session.
 * Uses the question.reply API to provide answers to the waiting tool.
 */
async function submitQuestionAnswers(context: PendingQuestionContext): Promise<void> {
  try {
    const clientV2 = getOpencodeClientV2(context.directory)
    if (!clientV2) {
      throw new Error('OpenCode server not found for directory')
    }

    // Build answers array: each element is an array of selected labels for that question
    const answers = context.questions.map((_, i) => {
      return context.answers[i] || []
    })

    await clientV2.question.reply({
      requestID: context.requestId,
      answers,
    })

    logger.log(
      `Submitted answers for question ${context.requestId} in session ${context.sessionId}`,
    )
  } catch (error) {
    logger.error('Failed to submit answers:', error)
    await sendThreadMessage(
      context.thread,
      `✗ Failed to submit answers: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

/**
 * Check if a tool part is an AskUserQuestion tool.
 * Returns the parsed input if valid, null otherwise.
 */
export function parseAskUserQuestionTool(part: {
  type: string
  tool?: string
  state?: { input?: unknown }
}): AskUserQuestionInput | null {
  if (part.type !== 'tool') {
    return null
  }

  // Check for the tool name (case-insensitive)
  const toolName = part.tool?.toLowerCase()
  if (toolName !== 'question') {
    return null
  }

  const input = part.state?.input as AskUserQuestionInput | undefined

  if (!input?.questions || !Array.isArray(input.questions) || input.questions.length === 0) {
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
 * Cancel a pending question for a thread (e.g., when user sends a new message).
 * Sends the user's message as the answer to OpenCode so the model sees their actual response.
 */
export async function cancelPendingQuestion(threadId: string, userMessage?: string): Promise<boolean> {
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
    return false
  }

  try {
    const clientV2 = getOpencodeClientV2(context.directory)
    if (!clientV2) {
      throw new Error('OpenCode server not found for directory')
    }

    // Use user's message as answer if provided, otherwise mark as "Other"
    const customAnswer = userMessage || 'Other'
    const answers = context.questions.map((_, i) => {
      return context.answers[i] || [customAnswer]
    })

    await clientV2.question.reply({
      requestID: context.requestId,
      answers,
    })

    logger.log(`Answered question ${context.requestId} with user message`)
  } catch (error) {
    logger.error('Failed to answer question:', error)
  }

  // Clean up regardless of whether the API call succeeded
  pendingQuestionContexts.delete(contextHash)
  return true
}
