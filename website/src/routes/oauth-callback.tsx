// GET /oauth/callback -- OAuth completion handler.
// Receives Discord redirect after user authorizes the bot, decodes the
// state parameter (base64url-encoded client_id:secret), validates format,
// inserts client+guild into the gateway_clients table, and renders a
// React success page telling the user to return to their terminal.

import type { Context } from 'hono'
import { renderToString } from 'react-dom/server'
import React from 'react'
import * as errore from 'errore'
import { prisma } from 'db/src/prisma.js'
import { SuccessPage } from '../components/success-page.js'
import {
  GatewayClientUpsertError,
  InvalidClientCredentialsError,
  InvalidStateFormatError,
  StateDecodeError,
} from '../errors.js'

// Validate client_id is a UUID and secret is a 64-char hex string
function validateCredentials(clientId: string, secret: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const hexRegex = /^[0-9a-f]{64}$/i
  return uuidRegex.test(clientId) && hexRegex.test(secret)
}

function parseCredentialsFromState({ stateParam }: { stateParam: string }) {
  const decoded = errore.try({
    try: () => {
      return Buffer.from(stateParam, 'base64url').toString('utf-8')
    },
    catch: (cause) => {
      return new StateDecodeError({ cause })
    },
  })
  if (decoded instanceof Error) {
    return decoded
  }

  const parts = decoded.split(':')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return new InvalidStateFormatError()
  }

  const clientId = parts[0]
  const secret = parts[1]
  if (!validateCredentials(clientId, secret)) {
    return new InvalidClientCredentialsError()
  }

  return { clientId, secret }
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

    if (InvalidClientCredentialsError.is(credentials)) {
      return c.text('Invalid client credentials format', 400)
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
