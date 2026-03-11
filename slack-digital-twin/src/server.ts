// HTTP server implementing Slack Web API routes (/api/*).
// All Slack Web API methods are POST requests that accept form or JSON bodies
// and return { ok: true, ... } or { ok: false, error: "..." }.
//
// This server is used by @slack/web-api WebClient configured with a custom
// slackApiUrl pointing to our local server.

import http from 'node:http'
import { Spiceflow } from 'spiceflow'
import type { PrismaClient } from './generated/client.js'
import { generateMessageTs, generateChannelId } from './slack-ids.js'
import { userToSlack, channelToSlack, messageToSlack } from './serializers.js'

export interface ServerConfig {
  prisma: PrismaClient
  workspaceId: string
  botUserId: string
  botToken: string
}

export interface ServerComponents {
  httpServer: http.Server
  app: Spiceflow
  port: number
}

// Parse Slack API request body. WebClient sends form-urlencoded or JSON
// depending on the method. We handle both.
async function parseBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return (await request.json()) as Record<string, string>
  }
  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    const text = await request.text()
    const params = new URLSearchParams(text)
    const result: Record<string, string> = {}
    for (const [key, value] of params.entries()) {
      result[key] = value
    }
    return result
  }
  // Fallback: try JSON
  const text = await request.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, string>
  } catch {
    return {}
  }
}

export function createServer(config: ServerConfig): ServerComponents {
  const { prisma, workspaceId, botUserId, botToken } = config
  const assistantThreadStatusByThread = new Map<string, string>()

  const app = new Spiceflow({ basePath: '' }).onError(({ error }) => {
    if (error instanceof Response) {
      return error
    }
    return Response.json(
      {
        ok: false,
        error: 'internal_error',
        details: getErrorMessage(error),
      },
      { status: 500 },
    )
  })

  // --- auth.test ---
  app.post('/api/auth.test', async ({ request }) => {
    const auth = request.headers.get('authorization') ?? ''
    if (!auth.includes(botToken)) {
      return Response.json({ ok: false, error: 'invalid_auth' }, { status: 401 })
    }
    const botUser = await prisma.user.findUnique({ where: { id: botUserId } })
    if (!botUser) {
      return Response.json({ ok: false, error: 'user_not_found' })
    }
    return Response.json({
      ok: true,
      url: `https://${workspaceId}.slack.com/`,
      team: workspaceId,
      user: botUser.name,
      team_id: workspaceId,
      user_id: botUserId,
      bot_id: `B${botUserId.slice(1)}`,
    })
  })

  // --- chat.postMessage ---
  app.post('/api/chat.postMessage', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel']
    const text = body['text'] ?? ''
    const threadTs = body['thread_ts'] || undefined
    const blocksRaw = body['blocks']

    if (!channelId) {
      return Response.json({ ok: false, error: 'channel_not_found' })
    }

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
    })
    if (!channel) {
      return Response.json({ ok: false, error: 'channel_not_found' })
    }

    const ts = generateMessageTs()
    const blocks = blocksRaw ? blocksRaw : '[]'

    await prisma.message.create({
      data: {
        channelId,
        userId: botUserId,
        botId: `B${botUserId.slice(1)}`,
        text,
        ts,
        threadTs,
        blocks: typeof blocks === 'string' ? blocks : JSON.stringify(blocks),
      },
    })

    return Response.json({
      ok: true,
      channel: channelId,
      ts,
      message: {
        type: 'message',
        text,
        bot_id: `B${botUserId.slice(1)}`,
        ts,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      },
    })
  })

  // --- chat.update ---
  app.post('/api/chat.update', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel']
    const ts = body['ts']
    const text = body['text'] ?? ''
    const blocksRaw = body['blocks']

    if (!channelId || !ts) {
      return Response.json({ ok: false, error: 'missing_required_field' })
    }

    const message = await prisma.message.findUnique({ where: { ts } })
    if (!message) {
      return Response.json({ ok: false, error: 'message_not_found' })
    }

    const editedTs = generateMessageTs()
    await prisma.message.update({
      where: { ts },
      data: {
        text,
        editedTs,
        ...(blocksRaw
          ? {
              blocks:
                typeof blocksRaw === 'string'
                  ? blocksRaw
                  : JSON.stringify(blocksRaw),
            }
          : {}),
      },
    })

    return Response.json({
      ok: true,
      channel: channelId,
      ts,
      text,
    })
  })

  // --- chat.delete ---
  app.post('/api/chat.delete', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel']
    const ts = body['ts']

    if (!channelId || !ts) {
      return Response.json({ ok: false, error: 'missing_required_field' })
    }

    const message = await prisma.message.findUnique({ where: { ts } })
    if (!message) {
      return Response.json({ ok: false, error: 'message_not_found' })
    }

    await prisma.message.update({
      where: { ts },
      data: { isDeleted: true },
    })

    return Response.json({ ok: true, channel: channelId, ts })
  })

  // --- assistant.threads.setStatus ---
  app.post('/api/assistant.threads.setStatus', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel_id']
    const threadTs = body['thread_ts']
    const status = body['status'] ?? ''

    if (!(channelId && threadTs)) {
      return Response.json({ ok: false, error: 'missing_required_field' })
    }

    const parentMessage = await prisma.message.findUnique({ where: { ts: threadTs } })
    if (!parentMessage || parentMessage.channelId !== channelId) {
      return Response.json({ ok: false, error: 'thread_not_found' })
    }

    const threadKey = `${channelId}:${threadTs}`
    if (status) {
      assistantThreadStatusByThread.set(threadKey, status)
    } else {
      assistantThreadStatusByThread.delete(threadKey)
    }

    return Response.json({
      ok: true,
    })
  })

  // --- conversations.history ---
  app.post('/api/conversations.history', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel']
    const limit = parseInt(body['limit'] ?? '100', 10)
    const latest = body['latest']
    const oldest = body['oldest']

    if (!channelId) {
      return Response.json({ ok: false, error: 'channel_not_found' })
    }

    const where: Record<string, unknown> = {
      channelId,
      isDeleted: false,
      threadTs: null, // history returns only top-level messages
    }

    // Slack's latest/oldest are ts-based cursors
    if (latest) {
      where['ts'] = { ...(where['ts'] as object ?? {}), lte: latest }
    }
    if (oldest) {
      where['ts'] = { ...(where['ts'] as object ?? {}), gte: oldest }
    }

    const messages = await prisma.message.findMany({
      where,
      orderBy: { ts: 'desc' },
      take: limit,
      include: { reactions: true },
    })

    return Response.json({
      ok: true,
      messages: messages.map((m) => {
        return messageToSlack({ message: m, reactions: m.reactions })
      }),
      has_more: false,
    })
  })

  // --- conversations.replies ---
  app.post('/api/conversations.replies', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel']
    const parentTs = body['ts']
    const limit = parseInt(body['limit'] ?? '100', 10)

    if (!channelId || !parentTs) {
      return Response.json({ ok: false, error: 'missing_required_field' })
    }

    // Replies include the parent message + all replies with threadTs = parentTs
    const messages = await prisma.message.findMany({
      where: {
        channelId,
        isDeleted: false,
        OR: [{ ts: parentTs }, { threadTs: parentTs }],
      },
      orderBy: { ts: 'asc' },
      take: limit,
      include: { reactions: true },
    })

    return Response.json({
      ok: true,
      messages: messages.map((m) => {
        return messageToSlack({ message: m, reactions: m.reactions })
      }),
      has_more: false,
    })
  })

  // --- conversations.info ---
  app.post('/api/conversations.info', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel']

    if (!channelId) {
      return Response.json({ ok: false, error: 'channel_not_found' })
    }

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
    })
    if (!channel) {
      return Response.json({ ok: false, error: 'channel_not_found' })
    }

    return Response.json({
      ok: true,
      channel: channelToSlack({ channel }),
    })
  })

  // --- conversations.list ---
  app.post('/api/conversations.list', async ({ request }) => {
    const body = await parseBody(request)
    const types = body['types'] ?? 'public_channel'
    const excludeArchived = body['exclude_archived'] !== 'false'

    const where: Record<string, unknown> = { workspaceId }
    if (excludeArchived) {
      where['isArchived'] = false
    }
    // Filter by channel types
    if (!types.includes('private_channel')) {
      where['isPrivate'] = false
    }

    const channels = await prisma.channel.findMany({ where })

    return Response.json({
      ok: true,
      channels: channels.map((c) => channelToSlack({ channel: c })),
    })
  })

  // --- reactions.add ---
  app.post('/api/reactions.add', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel']
    const ts = body['timestamp']
    const name = body['name']

    if (!channelId || !ts || !name) {
      return Response.json({ ok: false, error: 'missing_required_field' })
    }

    const message = await prisma.message.findUnique({ where: { ts } })
    if (!message) {
      return Response.json({ ok: false, error: 'message_not_found' })
    }

    // Check for duplicate
    const existing = await prisma.reaction.findUnique({
      where: {
        channelId_messageTs_userId_name: {
          channelId,
          messageTs: ts,
          userId: botUserId,
          name,
        },
      },
    })
    if (existing) {
      return Response.json({ ok: false, error: 'already_reacted' })
    }

    await prisma.reaction.create({
      data: { channelId, messageTs: ts, userId: botUserId, name },
    })

    return Response.json({ ok: true })
  })

  // --- reactions.remove ---
  app.post('/api/reactions.remove', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel']
    const ts = body['timestamp']
    const name = body['name']

    if (!channelId || !ts || !name) {
      return Response.json({ ok: false, error: 'missing_required_field' })
    }

    const existing = await prisma.reaction.findUnique({
      where: {
        channelId_messageTs_userId_name: {
          channelId,
          messageTs: ts,
          userId: botUserId,
          name,
        },
      },
    })
    if (!existing) {
      return Response.json({ ok: false, error: 'no_reaction' })
    }

    await prisma.reaction.delete({ where: { id: existing.id } })

    return Response.json({ ok: true })
  })

  // --- users.info ---
  app.post('/api/users.info', async ({ request }) => {
    const body = await parseBody(request)
    const userId = body['user']

    if (!userId) {
      return Response.json({ ok: false, error: 'user_not_found' })
    }

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      return Response.json({ ok: false, error: 'user_not_found' })
    }

    return Response.json({
      ok: true,
      user: userToSlack({ user, workspaceId }),
    })
  })

  // --- users.list ---
  app.post('/api/users.list', async ({ request }) => {
    const users = await prisma.user.findMany({
      where: { workspaceId },
    })

    return Response.json({
      ok: true,
      members: users.map((u) => userToSlack({ user: u, workspaceId })),
    })
  })

  // --- conversations.create ---
  app.post('/api/conversations.create', async ({ request }) => {
    const body = await parseBody(request)
    const name = body['name']
    const isPrivate = body['is_private'] === 'true'

    if (!name) {
      return Response.json({ ok: false, error: 'invalid_name_required' })
    }

    // Check for duplicate name
    const existing = await prisma.channel.findFirst({
      where: { workspaceId, name },
    })
    if (existing) {
      return Response.json({ ok: false, error: 'name_taken' })
    }

    const channelId = generateChannelId()
    const channel = await prisma.channel.create({
      data: {
        id: channelId,
        workspaceId,
        name,
        isPrivate,
      },
    })

    return Response.json({
      ok: true,
      channel: channelToSlack({ channel }),
    })
  })

  // --- conversations.rename ---
  app.post('/api/conversations.rename', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel']
    const name = body['name']

    if (!channelId || !name) {
      return Response.json({ ok: false, error: 'missing_required_field' })
    }

    const channel = await prisma.channel.findUnique({ where: { id: channelId } })
    if (!channel) {
      return Response.json({ ok: false, error: 'channel_not_found' })
    }

    const updated = await prisma.channel.update({
      where: { id: channelId },
      data: { name },
    })

    return Response.json({
      ok: true,
      channel: channelToSlack({ channel: updated }),
    })
  })

  // --- conversations.setTopic ---
  app.post('/api/conversations.setTopic', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel']
    const topic = body['topic'] ?? ''

    if (!channelId) {
      return Response.json({ ok: false, error: 'channel_not_found' })
    }

    const channel = await prisma.channel.findUnique({ where: { id: channelId } })
    if (!channel) {
      return Response.json({ ok: false, error: 'channel_not_found' })
    }

    const updated = await prisma.channel.update({
      where: { id: channelId },
      data: { topic },
    })

    return Response.json({
      ok: true,
      channel: channelToSlack({ channel: updated }),
    })
  })

  // --- conversations.archive ---
  app.post('/api/conversations.archive', async ({ request }) => {
    const body = await parseBody(request)
    const channelId = body['channel']

    if (!channelId) {
      return Response.json({ ok: false, error: 'channel_not_found' })
    }

    const channel = await prisma.channel.findUnique({ where: { id: channelId } })
    if (!channel) {
      return Response.json({ ok: false, error: 'channel_not_found' })
    }
    if (channel.isArchived) {
      return Response.json({ ok: false, error: 'already_archived' })
    }

    await prisma.channel.update({
      where: { id: channelId },
      data: { isArchived: true },
    })

    return Response.json({ ok: true })
  })

  // --- usergroups.list ---
  // Stub: returns empty list (no Slack usergroups by default).
  // The discord-slack-bridge maps these to Discord guild roles.
  app.post('/api/usergroups.list', async () => {
    return Response.json({
      ok: true,
      usergroups: [],
    })
  })

  // --- views.open ---
  // Stub: acknowledges modal open without rendering.
  // The discord-slack-bridge calls this for type-9 interaction responses.
  app.post('/api/views.open', async ({ request }) => {
    const body = await parseBody(request)
    return Response.json({
      ok: true,
      view: {
        id: `V${Date.now()}`,
        type: 'modal',
        title: { type: 'plain_text', text: 'Modal' },
      },
    })
  })

  // --- files.getUploadURLExternal ---
  // Stub: returns a fake upload URL
  app.post('/api/files.getUploadURLExternal', async ({ request }) => {
    const body = await parseBody(request)
    const filename = body['filename'] ?? 'file'
    const length = body['length'] ?? '0'
    const origin = new URL(request.url).origin

    return Response.json({
      ok: true,
      upload_url: `${origin}/fake-upload/${filename}`,
      file_id: `F${Date.now()}`,
    })
  })

  // --- fake upload target for files.getUploadURLExternal ---
  // Accepts both POST and PUT so bridge tests can exercise upload fallback logic.
  app.post('/fake-upload/:filename', async () => {
    return new Response(null, { status: 200 })
  })
  app.put('/fake-upload/:filename', async () => {
    return new Response(null, { status: 200 })
  })

  // --- files.completeUploadExternal ---
  // Stub: acknowledges upload completion
  app.post('/api/files.completeUploadExternal', async ({ request }) => {
    return Response.json({
      ok: true,
      files: [],
    })
  })

  // Build HTTP server
  const httpServer = http.createServer((req, res) => {
    return app.handleForNode(req, res)
  })

  return { httpServer, app, port: 0 }
}

export async function startServer(
  components: ServerComponents,
): Promise<number> {
  return new Promise((resolve) => {
    components.httpServer.listen(0, '127.0.0.1', () => {
      const addr = components.httpServer.address()
      const port =
        typeof addr === 'object' && addr ? addr.port : 0
      components.port = port
      resolve(port)
    })
  })
}

export async function stopServer(
  components: ServerComponents,
): Promise<void> {
  return new Promise((resolve, reject) => {
    components.httpServer.close((err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
