// Permissions feature (spec 10.2, 27.6): a permission request of any session
// in the thread (subagents included) becomes one message with Accept /
// Accept Always / Deny. No timeout: it waits until the user answers or a new
// message rejects it (prompt.ts steer).
//
//   permission.asked   ─▶ message + 3 buttons (custom id perm:<requestID>:<decision>)
//   click              ─▶ permission.reply
//   permission.replied ─▶ buttons removed, decision shown

import { ButtonStyle, MessageFlags, type ButtonInteraction } from 'discord.js'
import type { PermissionRequest } from '@opencode/client'

import { oc, type Bot } from './bot.ts'
import { createLogger } from './logger.ts'
import { castDraft, type Draft } from 'immer'

import { button, buttonRow, textOnly, type UiMessage } from './format-parts.ts'
import type { InteractionRoutes } from './interaction-context.ts'
import type { Emit, ThreadView } from './thread-reducer.ts'

const logger = createLogger('PERMISSION')

const PERMISSION_PREFIX = 'perm:'

export type PermissionDecision = 'once' | 'always' | 'reject'

export type PendingPermission = {
  sessionId: string
  action: string
  resources: readonly string[]
  label: string | null
}

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

export const STATUS: Record<PermissionDecision, string> = {
  once: '✓ _Accepted_',
  always: '✓ _Accepted always_',
  reject: '✗ _Denied_',
}

type Slice = { draft: Draft<ThreadView>; emit: Emit }

export function showPermission({ draft, emit, request, label }: Slice & { request: PermissionRequest; label: string | null }) {
  if (draft.permissions[request.id]) return
  const pending: PendingPermission = { sessionId: request.sessionID, action: request.action, resources: [...request.resources], label }
  draft.permissions[request.id] = castDraft(pending)
  emit({ type: 'show', key: uiKey(request.id), messages: [requestMessage({ requestID: request.id, request: pending })], replyTo: null, notify: true })
}

export function closePermission({ draft, emit, requestID, status }: Slice & { requestID: string; status: string }) {
  const request = draft.permissions[requestID]
  if (!request) return
  const text = `${describe(request)}\n${status}`
  delete draft.permissions[requestID]
  emit({ type: 'edit', key: uiKey(requestID), messages: [textOnly(text)] })
}

// After a (re)connect: pending requests of one session as OpenCode has them.
export function hydratePermissions(slice: Slice & { sessionId: string; requests: readonly PermissionRequest[]; label: string | null }) {
  const pending = new Set(slice.requests.map((request) => request.id))
  for (const [requestID, request] of Object.entries(slice.draft.permissions)) {
    if (request.sessionId === slice.sessionId && !pending.has(requestID)) closePermission({ ...slice, requestID, status: '_no longer pending_' })
  }
  for (const request of slice.requests) showPermission({ ...slice, request })
}

function parseDecision(value: string | undefined): PermissionDecision | null {
  return value === 'once' || value === 'always' || value === 'reject' ? value : null
}

async function handlePermissionButton(bot: Bot, interaction: ButtonInteraction): Promise<void> {
  const [requestID, rawDecision] = interaction.customId.slice(PERMISSION_PREFIX.length).split(':')
  const decision = parseDecision(rawDecision)
  const request = requestID ? bot.store.getState().threads[interaction.channelId]?.permissions[requestID] : undefined
  if (!requestID || !decision || !request) {
    await interaction.reply({ content: 'This permission request is no longer pending', flags: MessageFlags.Ephemeral })
    return
  }
  // The buttons go away when permission.replied arrives.
  await interaction.deferUpdate()
  const result = await oc(bot, 'permission.reply', (client) =>
    client.permission.reply({ sessionID: request.sessionId, requestID, decision }),
  )
  if (!(result instanceof Error)) return
  logger.warn(`reply ${requestID} failed`, result)
  await interaction.followUp({ content: 'This permission request is no longer pending', flags: MessageFlags.Ephemeral })
}

export const permissionRoutes: InteractionRoutes = { buttons: { [PERMISSION_PREFIX]: handlePermissionButton } }
