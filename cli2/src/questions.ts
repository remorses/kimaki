// Questions feature (spec 10.1, 27.6): the `question` tool creates a V2 form
// (metadata.kind "question"); Kimaki shows one message with a dropdown per
// question, like V1. Subagent questions show in the parent thread with a
// "From: <agent>" line.
//
//   form.created ─▶ one dropdown message per field (+ "Other" when custom)
//   select       ─▶ message shows "✓ answer"; last field answered ─▶ form.reply
//   "Other"      ─▶ modal with a text input ─▶ same as a select
//   form.replied / form.cancelled ─▶ every message of the form is settled
//
// Custom IDs carry only the form ID and field index. Answers of a form with
// several questions wait in a closure map until the last one (spec 27.4:
// wizard state lives in the feature that owns it; lost on restart, the user
// picks again).

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

import type { Actions } from './actions.ts'
import { createLogger } from './logger.ts'
import type { BotStore } from './store.ts'
import type { Effect, ThreadView } from './thread-reducer.ts'
import { settleUi, showUi, textOnly, type UiMessage } from './ui-prompts.ts'

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

type Result = { view: ThreadView; effects: Effect[] }

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

function answeredMessage({ field, label, answer }: { field: QuestionField; label: string | null; answer: string }) {
  return textOnly(`${header({ field, label })}\n✓ _${answer}_`)
}

function showForm({ view, form, label }: { view: ThreadView; form: FormLike; label: string | null }): Result {
  const fields = questionFields(form)
  if (!fields || view.forms[form.id]) return { view, effects: [] }
  const shown = showUi({
    ui: view.ui,
    key: uiKey(form.id),
    messages: fields.map((field, index) => questionMessage({ formID: form.id, index, field, label })),
  })
  return {
    view: { ...view, ui: shown.ui, forms: { ...view.forms, [form.id]: { sessionId: form.sessionID, fields, label } } },
    effects: shown.effects,
  }
}

function settleForm({ view, formID, status }: { view: ThreadView; formID: string; status: (field: QuestionField) => string }): Result {
  const form = view.forms[formID]
  if (!form) return { view, effects: [] }
  const { [formID]: _settled, ...forms } = view.forms
  const settled = settleUi({
    ui: view.ui,
    key: uiKey(formID),
    final: form.fields.map((field) => textOnly(`${header({ field, label: form.label })}\n${status(field)}`)),
  })
  return { view: { ...view, forms, ui: settled.ui }, effects: settled.effects }
}

// Form events of any session in the thread (root or subagent).
export function reduceForms({ view, event, label }: { view: ThreadView; event: V2Event; label: string | null }): Result | null {
  switch (event.type) {
    case 'form.created':
      return showForm({ view, form: event.data.form, label })
    case 'form.replied':
      return settleForm({
        view,
        formID: event.data.id,
        status: (field) => `✓ _${formatAnswer(event.data.answer[field.key])}_`,
      })
    case 'form.cancelled':
      return settleForm({ view, formID: event.data.id, status: () => '✗ _cancelled_' })
    default:
      return null
  }
}

// After a (re)connect: pending forms of one session as OpenCode has them.
// Unknown ones are shown (again); gone ones are settled.
export function hydrateForms({
  view,
  sessionId,
  forms,
  label,
}: {
  view: ThreadView
  sessionId: string
  forms: readonly FormLike[]
  label: string | null
}): Result {
  const pending = new Set(forms.map((form) => form.id))
  const gone = Object.entries(view.forms).filter(([formID, form]) => form.sessionId === sessionId && !pending.has(formID))
  const settled = gone.reduce<Result>(
    (acc, [formID]) => {
      const next = settleForm({ view: acc.view, formID, status: () => '_no longer pending_' })
      return { view: next.view, effects: [...acc.effects, ...next.effects] }
    },
    { view, effects: [] },
  )
  return forms.reduce<Result>((acc, form) => {
    const next = showForm({ view: acc.view, form, label })
    return { view: next.view, effects: [...acc.effects, ...next.effects] }
  }, settled)
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

export function createQuestionHandlers({ store, actions }: { store: BotStore; actions: Actions }) {
  // formID -> answers so far, for forms with several questions.
  const partial = new Map<string, FormAnswer>()

  function pendingField({ threadId, customId, prefix }: { threadId: string; customId: string; prefix: string }) {
    const parsed = parseCustomId(customId, prefix)
    if (!parsed) return null
    const form = store.getState().threads[threadId]?.forms[parsed.formID]
    const field = form?.fields[parsed.index]
    if (!form || !field) {
      partial.delete(parsed.formID)
      return null
    }
    return { formID: parsed.formID, form, field }
  }

  async function record({
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
  }) {
    const answers = { ...partial.get(formID), [field.key]: value }
    const complete = form.fields.every((candidate) => answers[candidate.key] !== undefined)
    if (complete) partial.delete(formID)
    if (!complete) partial.set(formID, answers)
    const answered = answeredMessage({ field, label: form.label, answer: formatAnswer(value) })
    await acknowledge({ interaction, content: answered.content })
    if (!complete) return
    const result = await actions.answerForm({ sessionId: form.sessionId, formID, answer: answers })
    if (!(result instanceof Error)) return
    logger.warn(`answer ${formID} failed: ${result.message}`)
    await interaction.followUp({ content: 'This question is no longer pending', flags: MessageFlags.Ephemeral })
  }

  async function expired(interaction: StringSelectMenuInteraction | ModalSubmitInteraction) {
    await interaction.reply({ content: 'This question is no longer pending', flags: MessageFlags.Ephemeral })
  }

  return {
    async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
      const pending = pendingField({ threadId: interaction.channelId, customId: interaction.customId, prefix: FORM_SELECT_PREFIX })
      if (!pending) return expired(interaction)
      const { formID, field } = pending
      if (interaction.values.includes(OTHER_VALUE)) {
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
      const values = interaction.values.flatMap((value) => {
        const option = field.options[Number(value)]
        return option ? [option.value] : []
      })
      await record({ interaction, ...pending, value: field.multiple ? values : (values[0] ?? '') })
    },

    async handleOther(interaction: ModalSubmitInteraction): Promise<void> {
      const pending = pendingField({ threadId: interaction.channelId ?? '', customId: interaction.customId, prefix: FORM_OTHER_PREFIX })
      if (!pending) return expired(interaction)
      const text = interaction.fields.getTextInputValue('answer').trim()
      await record({ interaction, ...pending, value: pending.field.multiple ? [text] : text })
    },
  }
}
