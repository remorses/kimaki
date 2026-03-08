// General utility functions for the bot.
// Includes Discord OAuth URL generation, array deduplication,
// abort error detection, and date/time formatting helpers.

import os from 'node:os'
import { PermissionsBitField } from 'discord.js'
import type { BotMode } from './database.js'
import * as errore from 'errore'

type GenerateInstallUrlOptions = {
  clientId: string
  permissions?: bigint[]
  scopes?: string[]
  guildId?: string
  disableGuildSelect?: boolean
  state?: string
  redirectUri?: string
  responseType?: string
}

export function generateBotInstallUrl({
  clientId,
  permissions = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.SendMessagesInThreads,
    PermissionsBitField.Flags.CreatePublicThreads,
    PermissionsBitField.Flags.ManageThreads,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.AddReactions,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.UseExternalEmojis,
    PermissionsBitField.Flags.AttachFiles,
    PermissionsBitField.Flags.Connect,
    PermissionsBitField.Flags.Speak,
    PermissionsBitField.Flags.ManageRoles,
    PermissionsBitField.Flags.ManageEvents,
    PermissionsBitField.Flags.CreateEvents,
  ],
  scopes = ['bot', 'applications.commands', 'identify', 'email'],
  guildId,
  disableGuildSelect = false,
  state,
  redirectUri,
  responseType,
}: GenerateInstallUrlOptions): string {
  const permissionsBitField = new PermissionsBitField(permissions)
  const permissionsValue = permissionsBitField.bitfield.toString()

  const url = new URL('https://discord.com/api/oauth2/authorize')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('permissions', permissionsValue)
  url.searchParams.set('scope', scopes.join(' '))

  if (guildId) {
    url.searchParams.set('guild_id', guildId)
  }

  if (disableGuildSelect) {
    url.searchParams.set('disable_guild_select', 'true')
  }

  if (state) {
    url.searchParams.set('state', state)
  }

  if (redirectUri) {
    url.searchParams.set('redirect_uri', redirectUri)
  }

  if (responseType) {
    url.searchParams.set('response_type', responseType)
  }

  return url.toString()
}

export const KIMAKI_GATEWAY_APP_ID =
  process.env.KIMAKI_GATEWAY_APP_ID || '1477605701202481173'
export const KIMAKI_WEBSITE_URL = process.env.KIMAKI_WEBSITE_URL || 'https://kimaki.xyz'

export function generateDiscordInstallUrlForBot({
  appId,
  mode,
  clientId,
  clientSecret,
  gatewayCallbackUrl,
}: {
  appId: string
  mode: BotMode
  clientId: string | null
  clientSecret: string | null
  /** Optional external URL to redirect to after OAuth completes instead of the
   *  default success page. The website appends ?guild_id=<id> before redirecting. */
  gatewayCallbackUrl?: string
}): Error | string {
  if (mode !== 'gateway') {
    return generateBotInstallUrl({ clientId: appId })
  }

  if (!clientId || !clientSecret) {
    return new Error('Gateway credentials are missing from local database')
  }

  // In gateway mode, redirect to the website's /discord-install route.
  // This initiates the better-auth OAuth flow with clientId/clientSecret
  // as additionalData, which better-auth stores in its verification table
  // and recovers after Discord redirects back to the callback.
  const url = new URL(`${KIMAKI_WEBSITE_URL}/discord-install`)
  url.searchParams.set('clientId', clientId)
  url.searchParams.set('clientSecret', clientSecret)
  if (gatewayCallbackUrl) {
    url.searchParams.set('callbackUrl', gatewayCallbackUrl)
  }
  return url.toString()
}

export function deduplicateByKey<T, K>(arr: T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>()
  return arr.filter((item) => {
    const key = keyFn(item)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

// Delegates to errore.isAbortError (walks cause chain for AbortError instances),
// then falls back to opencode server-specific abort patterns that aren't
// errore.AbortError but still represent aborted operations.
export function isAbortError(error: unknown): error is Error {
  if (errore.isAbortError(error)) return true
  if (!(error instanceof Error)) return false
  return (
    error.name === 'MessageAbortedError' ||
    error.message?.includes('aborted') === true
  )
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const TIME_DIVISIONS: Array<{
  amount: number
  name: Intl.RelativeTimeFormatUnit
}> = [
  { amount: 60, name: 'seconds' },
  { amount: 60, name: 'minutes' },
  { amount: 24, name: 'hours' },
  { amount: 7, name: 'days' },
  { amount: 4.34524, name: 'weeks' },
  { amount: 12, name: 'months' },
  { amount: Number.POSITIVE_INFINITY, name: 'years' },
]

export function formatDistanceToNow(date: Date): string {
  let duration = (date.getTime() - Date.now()) / 1000

  for (const division of TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.name)
    }
    duration /= division.amount
  }
  return rtf.format(Math.round(duration), 'years')
}

const dtf = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

export function formatDateTime(date: Date): string {
  return dtf.format(date)
}

// Comprehensive ANSI escape sequence regex covering CSI, OSC, and related sequences.
// Valid string terminator sequences are BEL, ESC\, and 0x9c.
const ANSI_REGEX = (() => {
  const ST = '(?:\\u0007|\\u001B\\u005C|\\u009C)'
  const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`
  const csi =
    '[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]'
  return new RegExp(`${osc}|${csi}`, 'g')
})()

export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '')
}

export function abbreviatePath(fullPath: string): string {
  const home = os.homedir()
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length)
  }
  return fullPath
}
