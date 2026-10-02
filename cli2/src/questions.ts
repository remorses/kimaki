// Questions feature (spec 10.1, 27.6): the `question` tool creates a V2 form
// (metadata.kind "question"); Kimaki shows one message with a dropdown per
// question, like V1. Subagent questions show in the parent thread with a
// "From: <agent>" line.
//
//   form.created ─▶ one dropdown message per field (+ "Other" when custom)
//   select       ─▶ message shows "✓ answer"; last field answered ─▶ form.reply
//   "Other"      ─▶ modal with a text input ─▶ same as a select
//   form.replied / form.cancelled ─▶ every message of the form is edited: answer or cancelled, no dropdown
//
// Custom IDs carry only the form ID and field index. Answers of a form with
// several questions wait in bot.local.formAnswers until the last one (lost on
// restart, the user picks again).

import {
  ActionRowBuilder,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js'
import type { FormInfo, JsonValue, V2Event } from '@opencode/client'

import { oc, type Bot } from './bot.ts'
import { createLogger } from './logger.ts'
import { castDraft, type Draft } from 'immer'

import { textOnly, type UiMessage } from './format-parts.ts'
import type { Emit, ThreadView } from './thread-reducer.ts'

const logger = createLogger('QUESTION')

export const FORM_SELECT_PREFIX = 'form:'
export const FORM_OTHER_PREFIX = 'form_other:'
const OTHER_VALUE = 'other'
// Discord: 25 options per select, one is "Other".
const MAX_OPTIONS = 24

export type QuestionField = {
  key: string
  title: string
  description: string
  multiple: boolean
  custom: boolean
  options: ReadonlyArray<{ value: string; label: string; description: string }>
}

export type PendingForm = {
  sessionId: string
  fields: readonly QuestionField[]
  // Subagent name for forms of child sessions.
  label: string | null
}

export type FormAnswer = { readonly [key: string]: string | readonly string[] }

// FormInfo from the list API and the form.created payload differ only in
// nominal field types; both have this shape.
type FormLike = {
  id: string
  sessionID: string
  metadata?: { readonly [key: string]: JsonValue }
  fields: FormInfo['fields'] | Extract<V2Event, { type: 'form.created' }>['data']['form']['fields']
}

function uiKey(formID: string): string {
  return `form:${formID}`
}

// null when the form is not a question form Kimaki can render.
function questionFields(form: FormLike): QuestionField[] | null {
  if (form.metadata?.['kind'] !== 'question') return null
  const fields = form.fields.map((field): QuestionField | null => {
    if (field.type !== 'string' && field.type !== 'multiselect') return null
    return {
      key: field.key,
      title: field.title ?? '',
      description: field.description ?? '',
      multiple: field.type === 'multiselect',
      custom: field.custom === true,
      options: (field.options ?? []).slice(0, MAX_OPTIONS).map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description ?? '',
      })),
    }
  })
  return fields.every((field) => field !== null) ? fields : null
}

function header({ field, label }: { field: QuestionField; label: string | null }): string {
  const from = label ? `**From:** \`${label}\`\n` : ''
  return `${from}**${field.title.slice(0, 200)}**\n${field.description.slice(0, 1_500)}`
}

function questionMessage({
  formID,
  index,
  field,
  label,
}: {
  formID: string
  index: number
  field: QuestionField
  label: string | null
}): UiMessage {
  const options = [
    ...field.options.map((option, optionIndex) => ({
      label: option.label.slice(0, 100),
      value: String(optionIndex),
      ...(option.description && { description: option.description.slice(0, 100) }),
    })),
    ...(field.custom ? [{ label: 'Other', value: OTHER_VALUE, description: 'Type your own answer' }] : []),
  ]
  return {
    content: header({ field, label }),
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: `${FORM_SELECT_PREFIX}${formID}:${index}`,
            placeholder: 'Select an option',
            options,
            min_values: 1,
            max_values: field.multiple ? options.length : 1,
          },
        ],
      },
    ],
  }
}

export function formatAnswer(value: string | readonly string[] | number | boolean | undefined): string {
  if (value === undefined) return 'no answer'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

const MESSAGE_LIMIT = 2_000

// Header plus "✓ answer" within one Discord message. Only the display is
// cut: OpenCode always gets the full answer.
export function withAnswer({ header: text, answer }: { header: string; answer: string }): string {
  const room = MESSAGE_LIMIT - text.length - 6
  return `${text}\n✓ _${answer.length > room ? `${answer.slice(0, room - 1)}…` : answer}_`
}

function answeredMessage({ field, label, answer }: { field: QuestionField; label: string | null; answer: string }) {
  return textOnly(withAnswer({ header: header({ field, label }), answer }))
}

type Slice = { draft: Draft<ThreadView>; emit: Emit }

export function showForm({ draft, emit, form, label }: Slice & { form: FormLike; label: string | null }) {
  const fields = questionFields(form)
  if (!fields || draft.forms[form.id]) return
  draft.forms[form.id] = castDraft({ sessionId: form.sessionID, fields, label })
  const messages = fields.map((field, index) => questionMessage({ formID: form.id, index, field, label }))
  emit({ type: 'show', key: uiKey(form.id), messages, replyTo: null })
}

// `render` builds each question's final text from its header.
export function closeForm({
  draft,
  emit,
  formID,
  render,
}: Slice & { formID: string; render: (field: QuestionField, header: string) => string }) {
  const form = draft.forms[formID]
  if (!form) return
  const messages = form.fields.map((field) => textOnly(render(field, header({ field, label: form.label }))))
  delete draft.forms[formID]
  emit({ type: 'edit', key: uiKey(formID), messages })
}

// After a (re)connect: pending forms of one session as OpenCode has them.
// Unknown ones are shown (again); gone ones are closed.
export function hydrateForms(slice: Slice & { sessionId: string; forms: readonly FormLike[]; label: string | null }) {
  const pending = new Set(slice.forms.map((form) => form.id))
  for (const [formID, form] of Object.entries(slice.draft.forms)) {
    if (form.sessionId !== slice.sessionId || pending.has(formID)) continue
    closeForm({ ...slice, formID, render: (_field, text) => `${text}\n_no longer pending_` })
  }
  for (const form of slice.forms) showForm({ ...slice, form })
}

// --- Discord handlers

function parseCustomId(customId: string, prefix: string): { formID: string; index: number } | null {
  const [formID, index] = customId.slice(prefix.length).split(':')
  const parsed = Number(index)
  if (!formID || !Number.isInteger(parsed)) return null
  return { formID, index: parsed }
}

// Shows the answer in the question's own message.
async function acknowledge({
  interaction,
  content,
}: {
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction
  content: string
}) {
  if (interaction.isStringSelectMenu() || interaction.isFromMessage()) {
    await interaction.update({ content, components: [] })
    return
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral })
}

function pendingField(bot: Bot, { threadId, customId, prefix }: { threadId: string; customId: string; prefix: string }) {
  const parsed = parseCustomId(customId, prefix)
  if (!parsed) return null
  const form = bot.store.getState().threads[threadId]?.forms[parsed.formID]
  const field = form?.fields[parsed.index]
  if (!form || !field) {
    bot.local.formAnswers.delete(parsed.formID)
    return null
  }
  return { formID: parsed.formID, form, field }
}

async function record(
  bot: Bot,
  {
    interaction,
    formID,
    form,
    field,
    value,
  }: {
    interaction: StringSelectMenuInteraction | ModalSubmitInteraction
    formID: string
    form: PendingForm
    field: QuestionField
    value: string | readonly string[]
  },
) {
  const answers = { ...bot.local.formAnswers.get(formID), [field.key]: value }
  const complete = form.fields.every((candidate) => answers[candidate.key] !== undefined)
  if (complete) bot.local.formAnswers.delete(formID)
  if (!complete) bot.local.formAnswers.set(formID, answers)
  const answered = answeredMessage({ field, label: form.label, answer: formatAnswer(value) })
  await acknowledge({ interaction, content: answered.content })
  if (!complete) return
  const result = await oc(bot, 'session.form.reply', (client) =>
    client.session.form.reply({ sessionID: form.sessionId, formID, answer: answers }),
  )
  if (!(result instanceof Error)) return
  logger.warn(`answer ${formID} failed: ${result.message}`)
  await interaction.followUp({ content: 'This question is no longer pending', flags: MessageFlags.Ephemeral })
}

async function expired(interaction: StringSelectMenuInteraction | ModalSubmitInteraction) {
  await interaction.reply({ content: 'This question is no longer pending', flags: MessageFlags.Ephemeral })
}

export async function handleFormSelect(bot: Bot, interaction: StringSelectMenuInteraction): Promise<void> {
  const pending = pendingField(bot, { threadId: interaction.channelId, customId: interaction.customId, prefix: FORM_SELECT_PREFIX })
  if (!pending) return expired(interaction)
  const { formID, field } = pending
  const values = interaction.values.flatMap((value) => {
    const option = field.options[Number(value)]
    return option ? [option.value] : []
  })
  if (interaction.values.includes(OTHER_VALUE)) {
    bot.local.pickedWithOther.set(`${formID}:${field.key}`, values)
    const input = new TextInputBuilder()
      .setCustomId('answer')
      .setLabel('Your answer')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(interaction.customId.replace(FORM_SELECT_PREFIX, FORM_OTHER_PREFIX))
        .setTitle((field.title || 'Answer').slice(0, 45))
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
    )
    return
  }
  await record(bot, { interaction, ...pending, value: field.multiple ? values : (values[0] ?? '') })
}

export async function handleFormOther(bot: Bot, interaction: ModalSubmitInteraction): Promise<void> {
  const pending = pendingField(bot, { threadId: interaction.channelId ?? '', customId: interaction.customId, prefix: FORM_OTHER_PREFIX })
  if (!pending) return expired(interaction)
  const text = interaction.fields.getTextInputValue('answer').trim()
  const key = `${pending.formID}:${pending.field.key}`
  const picked = bot.local.pickedWithOther.get(key) ?? []
  bot.local.pickedWithOther.delete(key)
  await record(bot, { interaction, ...pending, value: pending.field.multiple ? [...picked, text] : text })
}
