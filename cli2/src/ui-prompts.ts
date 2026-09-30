// Interactive Discord messages owned by a thread view: queue acks, question
// dropdowns, permission buttons. Pure helpers used by the feature reducers.
//
// The reducer never knows Discord message IDs up front. A `show` effect posts
// the messages; the executor feeds their IDs back as `kimaki.rendered`
// through the same reduce path. Settling (answered, cancelled, delivered) can
// happen before or after that, so each prompt is a small state machine:
//
//   show ──▶ { ids: null } ──rendered──▶ { ids } ──settle──▶ edit(ids), dropped
//                 │                                              ▲
//                 └──settle──▶ { ids: null, final } ──rendered───┘
//
// The only Discord facts kept in memory are these message IDs (spec 6.3 #4).

import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIComponentInMessageActionRow,
} from 'discord.js'

export type UiMessage = {
  content: string
  components: ReadonlyArray<APIActionRowComponent<APIComponentInMessageActionRow>>
}

export type UiEffect =
  // Posts the messages in order; the first replies to `replyTo` when set.
  | { type: 'show'; key: string; messages: readonly UiMessage[]; replyTo: string | null }
  | { type: 'edit'; messageId: string; message: UiMessage }

type UiEntry = {
  messageIds: readonly string[] | null
  // Set when the prompt settled before its messages were posted.
  final: readonly UiMessage[] | null
}

export type UiState = Readonly<Record<string, UiEntry>>

type UiResult = { ui: UiState; effects: UiEffect[] }

function without(ui: UiState, key: string): UiState {
  const { [key]: _removed, ...rest } = ui
  return rest
}

function edits({ messageIds, final }: { messageIds: readonly string[]; final: readonly UiMessage[] }): UiEffect[] {
  return messageIds.flatMap((messageId, index): UiEffect[] => {
    const message = final[index] ?? final[final.length - 1]
    return message ? [{ type: 'edit', messageId, message }] : []
  })
}

export function showUi({
  ui,
  key,
  messages,
  replyTo = null,
}: {
  ui: UiState
  key: string
  messages: readonly UiMessage[]
  replyTo?: string | null
}): UiResult {
  if (ui[key]) return { ui, effects: [] }
  return { ui: { ...ui, [key]: { messageIds: null, final: null } }, effects: [{ type: 'show', key, messages, replyTo }] }
}

export function renderedUi({ ui, key, messageIds }: { ui: UiState; key: string; messageIds: readonly string[] }): UiResult {
  const entry = ui[key]
  if (!entry) return { ui, effects: [] }
  if (entry.final) return { ui: without(ui, key), effects: edits({ messageIds, final: entry.final }) }
  return { ui: { ...ui, [key]: { messageIds, final: null } }, effects: [] }
}

// `final` replaces each message (by index; the last one covers the rest).
export function settleUi({ ui, key, final }: { ui: UiState; key: string; final: readonly UiMessage[] }): UiResult {
  const entry = ui[key]
  if (!entry) return { ui, effects: [] }
  if (entry.messageIds) return { ui: without(ui, key), effects: edits({ messageIds: entry.messageIds, final }) }
  return { ui: { ...ui, [key]: { messageIds: null, final } }, effects: [] }
}

export function textOnly(content: string): UiMessage {
  return { content, components: [] }
}

export function button({
  customId,
  label,
  style = ButtonStyle.Secondary,
}: {
  customId: string
  label: string
  style?: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger
}): APIButtonComponentWithCustomId {
  return { type: ComponentType.Button, custom_id: customId, label, style }
}

export function buttonRow(
  buttons: readonly APIButtonComponentWithCustomId[],
): APIActionRowComponent<APIComponentInMessageActionRow> {
  return { type: ComponentType.ActionRow, components: [...buttons] }
}
