import type {
  MessageListInput,
  OpenCodeClient,
  SessionInfo,
  SessionListInput,
  SessionMessageInfo,
  SessionMessagesResponse,
  SessionsResponse,
} from '@opencode/client'
import * as errore from 'errore'

const MESSAGE_PAGE_LIMIT = 200
const SESSION_PAGE_LIMIT = 100

type PaginationOrder = 'asc' | 'desc'
type PaginationResource = 'messages' | 'sessions'

export class OpencodePaginationRequestError extends errore.createTaggedError({
  name: 'OpencodePaginationRequestError',
  message: 'Failed to list OpenCode $resource',
}) {}

export class RepeatedOpencodeCursorError extends errore.createTaggedError({
  name: 'RepeatedOpencodeCursorError',
  message: 'OpenCode returned repeated $resource cursor $cursor',
}) {}

function getRepeatedCursorError({
  cursor,
  resource,
  seenCursors,
}: {
  cursor: string
  resource: PaginationResource
  seenCursors: Set<string>
}) {
  if (!seenCursors.has(cursor)) return null
  return new RepeatedOpencodeCursorError({ cursor, resource })
}

export async function listAllMessages({
  client,
  sessionId,
  order,
  type,
  stopWhen,
}: {
  client: OpenCodeClient
  sessionId: string
  order: PaginationOrder
  type?: MessageListInput['type']
  stopWhen?: (message: SessionMessageInfo) => boolean
}): Promise<
  OpencodePaginationRequestError
  | RepeatedOpencodeCursorError
  | SessionMessageInfo[]
> {
  const messages: SessionMessageInfo[] = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null

  while (true) {
    const page: SessionMessagesResponse | OpencodePaginationRequestError =
      await client.message
        .list({
          sessionID: sessionId,
          limit: MESSAGE_PAGE_LIMIT,
          ...(cursor === null ? { order } : { cursor }),
          ...(type === undefined ? {} : { type }),
        })
        .catch((cause) => {
          return new OpencodePaginationRequestError({
            resource: 'messages',
            cause,
          })
        })
    if (page instanceof OpencodePaginationRequestError) return page

    for (const message of page.data) {
      messages.push(message)
      if (stopWhen?.(message)) return messages
    }

    const nextCursor: string | null | undefined = page.cursor.next
    if (nextCursor === null || nextCursor === undefined) return messages

    const repeatedCursorError = getRepeatedCursorError({
      cursor: nextCursor,
      resource: 'messages',
      seenCursors,
    })
    if (repeatedCursorError) return repeatedCursorError

    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
}

export async function listAllSessions({
  client,
  directory,
  parentId,
  order,
  stopWhen,
}: {
  client: OpenCodeClient
  directory?: string
  parentId?: string | null
  order: PaginationOrder
  stopWhen?: (session: SessionInfo) => boolean
}): Promise<
  OpencodePaginationRequestError
  | RepeatedOpencodeCursorError
  | SessionInfo[]
> {
  const sessions: SessionInfo[] = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null

  while (true) {
    const input: SessionListInput = {
      limit: SESSION_PAGE_LIMIT,
      ...(cursor === null ? { order } : { cursor }),
      ...(directory === undefined ? {} : { directory }),
      ...(parentId === undefined ? {} : { parentID: parentId }),
    }
    const page: SessionsResponse | OpencodePaginationRequestError =
      await client.session.list(input).catch((cause) => {
        return new OpencodePaginationRequestError({
          resource: 'sessions',
          cause,
        })
      })
    if (page instanceof OpencodePaginationRequestError) return page

    for (const session of page.data) {
      sessions.push(session)
      if (stopWhen?.(session)) return sessions
    }

    const nextCursor: string | null | undefined = page.cursor.next
    if (nextCursor === null || nextCursor === undefined) return sessions

    const repeatedCursorError = getRepeatedCursorError({
      cursor: nextCursor,
      resource: 'sessions',
      seenCursors,
    })
    if (repeatedCursorError) return repeatedCursorError

    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
}
