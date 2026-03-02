// GET /api/onboarding/status -- CLI polling endpoint.
// The kimaki CLI polls this endpoint every 2s during gateway mode onboarding
// to check if the user has completed the bot authorization flow.
// Returns 404 if not ready, 200 with guild_id if the client has been registered.

import type { Context } from 'hono'
import { createPrisma } from 'db/src/prisma.js'
import { GatewayClientLookupError } from '../errors.js'

async function findGatewayClientByCredentials({
  clientId,
  secret,
}: {
  clientId: string
  secret: string
}) {
  const prisma = createPrisma()
  return await prisma.gateway_clients
    .findFirst({
      where: { client_id: clientId, secret },
    })
    .catch((cause) => {
      return new GatewayClientLookupError({ clientId, cause })
    })
}

export async function handleOnboardingStatus(c: Context) {
  const clientId = c.req.query('client_id')
  const secret = c.req.query('secret')

  if (!clientId || !secret) {
    return c.json({ error: 'Missing client_id or secret' }, 400)
  }

  const row = await findGatewayClientByCredentials({ clientId, secret })
  if (row instanceof Error) {
    return c.json({ error: 'Internal server error' }, 500)
  }

  if (!row) {
    return c.json({ error: 'Not found' }, 404)
  }

  return c.json({ guild_id: row.guild_id })
}
