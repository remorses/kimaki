// Permissions feature (spec 10.2, 27.6): a permission request of any session
// in the thread (subagents included) becomes one message with Accept /
// Accept Always / Deny. No timeout: it waits until the user answers or a new
// message rejects it (actions.steer).
//
//   permission.asked   ─▶ message + 3 buttons (custom id perm:<requestID>:<decision>)
//   click              ─▶ permission.reply
//   permission.replied ─▶ buttons removed, decision shown

import { ButtonStyle, MessageFlags, type ButtonInteraction } from 'discord.js'
import type { PermissionRequest, V2Event } from '@opencode/client'

import type { Actions } from './actions.ts'
import { createLogger } from './logger.ts'
import type { BotStore } from './store.ts'
import type { Effect, ThreadView } from './thread-reducer.ts'
import { button, buttonRow, settleUi, showUi, textOnly, type UiMessage } from './ui-prompts.ts'

const logger = createLogger('PERMISSION')

export const PERMISSION_PREFIX = 'perm:'

export type PermissionDecision = 'once' | 'always' | 'reject'

export type PendingPermission = {
  sessionId: string
  action: string
  resources: readonly string[]
  label: string | null
}

type Result = { view: ThreadView; effects: Effect[] }

function uiKey(requestID: string): string {
  return `perm:${requestID}`
}

function code(text: string): string {
  return `\`${text.replaceAll('`', 'ʼ')}\``
}

function describe(request: PendingPermission): string {
  const lines = [
    '**Permission required**',
    request.label ? `**From:** ${code(request.label)}` : null,
    `**Type:** ${code(request.action)}`,
    request.action === 'external_directory' ? 'The agent is accessing files outside the project.' : null,
    request.resources.length > 0 ? `**Pattern:** ${request.resources.map(code).join(', ')}` : null,
  ]
  return lines.filter((line) => line !== null).join('\n').slice(0, 1_900)
}

function requestMessage({ requestID, request }: { requestID: string; request: PendingPermission }): UiMessage {
  const id = (decision: PermissionDecision) => `${PERMISSION_PREFIX}${requestID}:${decision}`
  return {
    content: describe(request),
    components: [
      buttonRow([
        button({ customId: id('once'), label: 'Accept', style: ButtonStyle.Success }),
        button({ customId: id('always'), label: 'Accept Always', style: ButtonStyle.Primary }),
        button({ customId: id('reject'), label: 'Deny', style: ButtonStyle.Danger }),
      ]),
    ],
  }
}

const STATUS: Record<PermissionDecision, string> = {
  once: '✓ _Accepted_',
  always: '✓ _Accepted always_',
  reject: '✗ _Denied_',
}

function showRequest({ view, request }: { view: ThreadView; request: PermissionRequest & { label: string | null } }): Result {
  if (view.permissions[request.id]) return { view, effects: [] }
  const pending: PendingPermission = {
    sessionId: request.sessionID,
    action: request.action,
    resources: request.resources,
    label: request.label,
  }
  const shown = showUi({ ui: view.ui, key: uiKey(request.id), messages: [requestMessage({ requestID: request.id, request: pending })] })
  return {
    view: { ...view, ui: shown.ui, permissions: { ...view.permissions, [request.id]: pending } },
    effects: shown.effects,
  }
}

function settleRequest({ view, requestID, status }: { view: ThreadView; requestID: string; status: string }): Result {
  const request = view.permissions[requestID]
  if (!request) return { view, effects: [] }
  const { [requestID]: _settled, ...permissions } = view.permissions
  const settled = settleUi({ ui: view.ui, key: uiKey(requestID), final: [textOnly(`${describe(request)}\n${status}`)] })
  return { view: { ...view, permissions, ui: settled.ui }, effects: settled.effects }
}

export function reducePermissions({
  view,
  event,
  label,
}: {
  view: ThreadView
  event: V2Event
  label: string | null
}): Result | null {
  switch (event.type) {
    case 'permission.asked':
      return showRequest({ view, request: { ...event.data, label } })
    case 'permission.replied':
      return settleRequest({ view, requestID: event.data.requestID, status: STATUS[event.data.reply] })
    default:
      return null
  }
}

// After a (re)connect: pending requests of one session as OpenCode has them.
export function hydratePermissions({
  view,
  sessionId,
  requests,
  label,
}: {
  view: ThreadView
  sessionId: string
  requests: readonly PermissionRequest[]
  label: string | null
}): Result {
  const pending = new Set(requests.map((request) => request.id))
  const gone = Object.entries(view.permissions).filter(([id, request]) => request.sessionId === sessionId && !pending.has(id))
  const settled = gone.reduce<Result>(
    (acc, [requestID]) => {
      const next = settleRequest({ view: acc.view, requestID, status: '_no longer pending_' })
      return { view: next.view, effects: [...acc.effects, ...next.effects] }
    },
    { view, effects: [] },
  )
  return requests.reduce<Result>((acc, request) => {
    const next = showRequest({ view: acc.view, request: { ...request, label } })
    return { view: next.view, effects: [...acc.effects, ...next.effects] }
  }, settled)
}

function parseDecision(value: string | undefined): PermissionDecision | null {
  return value === 'once' || value === 'always' || value === 'reject' ? value : null
}

export async function handlePermissionButton({
  interaction,
  store,
  actions,
}: {
  interaction: ButtonInteraction
  store: BotStore
  actions: Actions
}): Promise<void> {
  const [requestID, rawDecision] = interaction.customId.slice(PERMISSION_PREFIX.length).split(':')
  const decision = parseDecision(rawDecision)
  const request = requestID ? store.getState().threads[interaction.channelId]?.permissions[requestID] : undefined
  if (!requestID || !decision || !request) {
    await interaction.reply({ content: 'This permission request is no longer pending', flags: MessageFlags.Ephemeral })
    return
  }
  // The buttons go away when permission.replied arrives.
  await interaction.deferUpdate()
  const result = await actions.replyPermission({ sessionId: request.sessionId, requestID, decision })
  if (!(result instanceof Error)) return
  logger.warn(`reply ${requestID} failed: ${result.message}`)
  await interaction.followUp({ content: 'This permission request is no longer pending', flags: MessageFlags.Ephemeral })
}
