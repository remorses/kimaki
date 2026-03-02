// GET /oauth/callback -- OAuth completion handler.
// Receives Discord redirect after user authorizes the bot, parses the
// state parameter (URL-encoded JSON with clientId + clientSecret),
// validates format, inserts client+guild into the gateway_clients table,
// and renders a React success page telling the user to return to their terminal.

import type { Context } from 'hono'
import { renderToString } from 'react-dom/server'
import React from 'react'
import * as errore from 'errore'
import { createPrisma } from 'db/src/prisma.js'
import { decodeGatewayOAuthState } from 'db/src/gateway-state.js'
import { SuccessPage } from '../components/success-page.js'
import {
  GatewayClientUpsertError,
  InvalidStateFormatError,
  StateDecodeError,
} from '../errors.js'
import type { HonoBindings } from '../index.js'

function parseCredentialsFromState({ stateParam }: { stateParam: string }) {
  const parsed = errore.try({
    try: () => {
      return decodeGatewayOAuthState(stateParam)
    },
    catch: (cause) => {
      return new StateDecodeError({ cause })
    },
  })
  if (parsed instanceof Error) {
    return parsed
  }

  if (!parsed) {
    return new InvalidStateFormatError()
  }

  return { clientId: parsed.clientId, secret: parsed.clientSecret }
}

async function upsertGatewayClient({
  connectionString,
  clientId,
  secret,
  guildId,
}: {
  connectionString: string
  clientId: string
  secret: string
  guildId: string
}) {
  const prisma = createPrisma(connectionString)
  const upsertResult = await prisma.gateway_clients
    .upsert({
      where: {
        client_id_guild_id: { client_id: clientId, guild_id: guildId },
      },
      create: { client_id: clientId, secret, guild_id: guildId },
      update: { secret },
    })
    .catch((cause) => {
      return new GatewayClientUpsertError({ clientId, guildId, cause })
    })
  if (upsertResult instanceof Error) {
    return upsertResult
  }

  return null
}

export async function handleOAuthCallback(c: Context<{ Bindings: HonoBindings }>) {
  const guildId = c.req.query('guild_id')
  const stateParam = c.req.query('state')

  if (!guildId || !stateParam) {
    return c.text('Missing guild_id or state parameter', 400)
  }

  const credentials = parseCredentialsFromState({ stateParam })
  if (credentials instanceof Error) {
    if (StateDecodeError.is(credentials)) {
      return c.text('Failed to decode state parameter', 400)
    }

    if (InvalidStateFormatError.is(credentials)) {
      return c.text('Invalid state parameter format', 400)
    }

    return c.text('Internal server error', 500)
  }

  const upsertError = await upsertGatewayClient({
    connectionString: c.env.HYPERDRIVE.connectionString,
    clientId: credentials.clientId,
    secret: credentials.secret,
    guildId,
  })
  if (upsertError instanceof Error) {
    return c.text('Internal server error', 500)
  }

  const html = renderToString(<SuccessPage guildId={guildId} />)
  return c.html(`<!DOCTYPE html>${html}`)
}
