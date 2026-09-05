// Push the soonest local task/sleep wake time to PlanetScale so gateway-proxy
// can boot a stopped cloud machine before the job is due.

import { createLogger, LogPrefix } from './logger.js'
import { isScaleToZeroEnabled } from './scale-to-zero.js'
import { KIMAKI_WEBSITE_URL } from './utils.js'
import { store } from './store.js'

const logger = createLogger(LogPrefix.CLOUD)

let dirty = false
let inFlight: Promise<Error | void> | null = null

export function buildCloudNextWakeBody({
  nextWakeAt,
}: {
  nextWakeAt: Date | null
}) {
  return {
    next_wake_at: nextWakeAt ? nextWakeAt.toISOString() : null,
  }
}

function resolveGatewayWakeToken() {
  const stored = store.getState().gatewayToken
  if (stored && stored.includes(':')) {
    return stored
  }
  return null
}

export async function postCloudNextWakeAt({
  nextWakeAt,
  token,
  fetchImpl = fetch,
}: {
  nextWakeAt: Date | null
  token: string
  fetchImpl?: typeof fetch
}) {
  const response = await fetchImpl(`${KIMAKI_WEBSITE_URL}/api/cloud/next-wake`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildCloudNextWakeBody({ nextWakeAt })),
  }).catch((cause) => {
    return new Error('Failed to sync next wake time', { cause })
  })
  if (response instanceof Error) {
    logger.warn(response.message)
    return response
  }
  if (!response.ok) {
    const error = new Error(`Wake sync failed with HTTP ${response.status}`)
    logger.warn(error.message)
    return error
  }
}

export async function syncCloudNextWakeAt({
  nextWakeAt,
  fetchImpl = fetch,
}: {
  nextWakeAt: Date | null
  fetchImpl?: typeof fetch
}) {
  if (!isScaleToZeroEnabled()) {
    return
  }
  const token = resolveGatewayWakeToken()
  if (!token) {
    return new Error('Missing gateway token for cloud wake sync')
  }
  return postCloudNextWakeAt({ nextWakeAt, token, fetchImpl })
}

export async function syncSoonestCloudWakeAt({
  getSoonestWakeAt,
  fetchImpl = fetch,
}: {
  getSoonestWakeAt: () => Promise<Date | Error | null>
  fetchImpl?: typeof fetch
}) {
  dirty = true
  if (inFlight) {
    return inFlight
  }
  inFlight = (async () => {
    let lastError: Error | undefined
    while (dirty) {
      dirty = false
      const nextWakeAt = await getSoonestWakeAt()
      if (nextWakeAt instanceof Error) {
        logger.warn(`Failed to read next wake time: ${nextWakeAt.message}`)
        lastError = nextWakeAt
        continue
      }
      const result = await syncCloudNextWakeAt({ nextWakeAt, fetchImpl })
      if (result instanceof Error) {
        lastError = result
      }
    }
    return lastError
  })()
  const result = await inFlight
  inFlight = null
  if (dirty) {
    return syncSoonestCloudWakeAt({ getSoonestWakeAt, fetchImpl })
  }
  return result
}
