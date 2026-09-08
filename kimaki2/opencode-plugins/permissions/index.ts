// permission.asked → Discord buttons. Click replies once / always / reject.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ThreadChannel,
} from 'discord.js'
import { Plugin } from '@opencode-ai/plugin'
import { getClient, logPluginError } from '../discord/client.ts'
import { findBySessionId, getContext } from '../threads/registry.ts'
import { canReplyToPermission } from './access.ts'
import { parsePermissionCustomId, permissionContextHash, permissionCustomId } from './hash.ts'
import {
  findPendingByRequestID,
  removePendingForDirectory,
  savePending,
  takePending,
} from './store.ts'

const NOTIFY = 4

function permissionText({
  action,
  resources,
  message,
  status,
}: {
  action: string
  resources: string[]
  message?: string
  status?: string
}) {
  const resourceLine = resources.length ? `**Resource:** \`${resources.join(', ')}\`\n` : ''
  const extra = message ? `${message}\n` : ''
  const statusLine = status ? `${status}` : ''
  return `**Permission required**\n**Type:** \`${action}\`\n${resourceLine}${extra}${statusLine}`.trim()
}

async function sendButtons({
  thread,
  requestID,
  action,
  resources,
  message,
}: {
  thread: ThreadChannel
  requestID: string
  action: string
  resources: string[]
  message?: string
}) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(permissionCustomId({ reply: 'once', requestID }))
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(permissionCustomId({ reply: 'always', requestID }))
      .setLabel('Accept always')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(permissionCustomId({ reply: 'reject', requestID }))
      .setLabel('Deny')
      .setStyle(ButtonStyle.Secondary),
  )
  return thread.send({
    content: permissionText({ action, resources, message }).slice(0, 1900),
    components: [row],
    flags: NOTIFY | MessageFlags.SuppressEmbeds,
    allowedMentions: { parse: [] },
  })
}

const REPLY_LABEL = { once: 'accepted', always: 'accepted always', reject: 'denied' }

async function settlePermissionMessage({
  pending,
  status,
}: {
  pending: { messageId?: string; threadId: string; action: string; resources: string[]; message?: string }
  status: string
}) {
  if (!pending.messageId) return
  const client = getClient()
  if (!client) return
  const thread = await client.channels.fetch(pending.threadId).catch(() => null)
  if (!thread || !thread.isThread()) return
  const message = await thread.messages.fetch(pending.messageId).catch(() => null)
  if (!message) return
  await message
    .edit({
      content: permissionText({
        action: pending.action,
        resources: pending.resources,
        message: pending.message,
        status,
      }),
      components: [],
      allowedMentions: { parse: [] },
    })
    .catch(() => {})
}

export async function handlePermissionButton(interaction: ButtonInteraction) {
  const parsed = parsePermissionCustomId(interaction.customId)
  if (!parsed) return false
  if (!canReplyToPermission(interaction)) {
    await interaction.reply({ content: 'You cannot reply to this permission request.', ephemeral: true }).catch(() => {})
    return true
  }
  const pending = takePending(parsed.hash)
  if (!pending) {
    await interaction.reply({ content: 'This permission request expired.', ephemeral: true }).catch(() => {})
    return true
  }
  const ctx = getContext(pending.directory)
  if (!ctx) {
    savePending(pending)
    await interaction.reply({ content: 'OpenCode location is gone.', ephemeral: true }).catch(() => {})
    return true
  }
  await interaction.deferUpdate()
  const replied = await ctx.permission
    .reply({
      sessionID: pending.sessionID,
      requestID: pending.requestID,
      reply: parsed.reply,
    })
    .catch((error: unknown) => error)
  if (replied instanceof Error) {
    savePending(pending)
    logPluginError(replied)
    await interaction
      .followUp({ content: 'Could not process this permission. Try again.', ephemeral: true })
      .catch(() => {})
    return true
  }
  await settlePermissionMessage({ pending, status: `_${REPLY_LABEL[parsed.reply]}_` })
  return true
}

export default Plugin.define({
  id: 'kimaki.permissions',
  async setup(ctx) {
    const controller = new AbortController()
    const sub = ctx.event.subscribe({ signal: controller.signal })
    void (async () => {
      for await (const event of sub) {
        if (controller.signal.aborted) return
        if (event.location?.directory && event.location.directory !== ctx.location.directory) continue
        if (event.type === 'permission.replied') {
          const requestID = (event.data as { requestID?: string }).requestID
          const reply = (event.data as { reply?: string }).reply
          if (typeof requestID !== 'string') continue
          const pending = findPendingByRequestID(requestID)
          if (!pending || pending.directory !== ctx.location.directory) continue
          takePending(pending.hash)
          const status =
            reply === 'once' || reply === 'always' || reply === 'reject'
              ? `_${REPLY_LABEL[reply]}_`
              : '_replied_'
          await settlePermissionMessage({ pending, status })
          continue
        }
        if (event.type !== 'permission.asked') continue
        const data = event.data as {
          id?: string
          sessionID?: string
          action?: string
          resources?: string[]
          message?: string
        }
        const requestID = data.id
        const sessionID = data.sessionID
        if (typeof requestID !== 'string' || typeof sessionID !== 'string') continue
        const record = findBySessionId(sessionID)
        if (!record || record.directory !== ctx.location.directory) continue
        const client = getClient()
        if (!client) continue
        const thread = await client.channels.fetch(record.threadId)
        if (!thread || !thread.isThread()) continue
        const resources = Array.isArray(data.resources) ? data.resources.filter((item) => typeof item === 'string') : []
        const posted = await sendButtons({
          thread,
          requestID,
          action: typeof data.action === 'string' ? data.action : 'unknown',
          resources,
          message: typeof data.message === 'string' ? data.message : undefined,
        }).catch((error: unknown) => {
          logPluginError(error)
          return null
        })
        if (!posted) continue
        savePending({
          requestID,
          sessionID,
          directory: record.directory,
          action: typeof data.action === 'string' ? data.action : 'unknown',
          resources,
          message: typeof data.message === 'string' ? data.message : undefined,
          hash: permissionContextHash(requestID),
          messageId: posted.id,
          threadId: thread.id,
        })
      }
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return
      logPluginError(error)
    })
    return () => {
      controller.abort()
      removePendingForDirectory(ctx.location.directory)
    }
  },
})
