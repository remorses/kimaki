import { createHash } from 'node:crypto'

export function permissionContextHash(requestID: string) {
  return createHash('sha256').update(requestID).digest('hex').slice(0, 16)
}

export function permissionCustomId({
  reply,
  requestID,
}: {
  reply: 'once' | 'always' | 'reject'
  requestID: string
}) {
  return `perm_${reply}:${permissionContextHash(requestID)}`
}

export function parsePermissionCustomId(customId: string) {
  const match = customId.match(/^perm_(once|always|reject):([0-9a-f]{16})$/)
  if (!match?.[1] || !match[2]) return null
  return {
    reply: match[1] as 'once' | 'always' | 'reject',
    hash: match[2],
  }
}
