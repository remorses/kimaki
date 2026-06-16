// Extracts Slack workspace/team IDs from inbound webhook payloads.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key]
  return Array.isArray(value) ? value : []
}

function getTeamIdFromJsonPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const topLevelTeamId = readString(payload, 'team_id')
  if (topLevelTeamId) {
    return topLevelTeamId
  }

  const teamRecord = readRecord(payload, 'team')
  if (teamRecord) {
    const nestedTeamId = readString(teamRecord, 'id')
    if (nestedTeamId) {
      return nestedTeamId
    }
  }

  const authorizations = readArray(payload, 'authorizations')
  for (const authorization of authorizations) {
    if (!isRecord(authorization)) {
      continue
    }
    const teamId = readString(authorization, 'team_id')
    if (teamId) {
      return teamId
    }
  }

  return undefined
}

export function getTeamIdForWebhookEvent({
  body,
  contentType,
}: {
  body: string
  contentType?: string
}): string | undefined {
  const normalizedContentType = contentType?.toLowerCase() ?? ''

  if (normalizedContentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(body)
    const slashTeamId = params.get('team_id')
    if (slashTeamId) {
      return slashTeamId
    }

    const payloadStr = params.get('payload')
    if (!payloadStr) {
      return undefined
    }

    try {
      const payload = JSON.parse(payloadStr)
      return getTeamIdFromJsonPayload(payload)
    } catch {
      return undefined
    }
  }

  try {
    const payload = JSON.parse(body)
    return getTeamIdFromJsonPayload(payload)
  } catch {
    return undefined
  }
}
