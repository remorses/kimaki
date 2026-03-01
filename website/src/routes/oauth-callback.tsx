// GET /oauth/callback -- OAuth completion handler.
// Receives Discord redirect after user authorizes the bot, parses the
// state parameter (URL-encoded JSON with clientId + clientSecret),
// validates format, inserts client+guild into the gateway_clients table,
// and renders a React success page telling the user to return to their terminal.

import type { Context } from 'hono'
import { renderToString } from 'react-dom/server'
import React from 'react'
import * as errore from 'errore'
import { prisma } from 'db/src/prisma.js'
import { SuccessPage } from '../components/success-page.js'
import {
  GatewayClientUpsertError,
  InvalidStateFormatError,
  StateDecodeError,
} from '../errors.js'

// State is a JSON object: { clientId, clientSecret }
// URL-encoded by the browser, so we just JSON.parse the raw string.
function parseCredentialsFromState({ stateParam }: { stateParam: string }) {
  const parsed = errore.try({
    try: () => {
      return JSON.parse(stateParam) as { clientId?: string; clientSecret?: string }
    },
    catch: (cause) => {
      return new StateDecodeError({ cause })
    },
  })
  if (parsed instanceof Error) {
    return parsed
  }

  if (!parsed.clientId || !parsed.clientSecret) {
    return new InvalidStateFormatError()
  }

  return { clientId: parsed.clientId, secret: parsed.clientSecret }
}

async function upsertGatewayClient({
  clientId,
  secret,
  guildId,
}: {
  clientId: string
  secret: string
  guildId: string
}) {
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

export async function handleOAuthCallback(c: Context) {
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
