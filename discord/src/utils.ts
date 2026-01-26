// General utility functions for the bot.
// Includes Discord OAuth URL generation, array deduplication,
// abort error detection, and date/time formatting helpers.

import os from 'node:os'
import { PermissionsBitField } from 'discord.js'

type GenerateInstallUrlOptions = {
  clientId: string
  permissions?: bigint[]
  scopes?: string[]
  guildId?: string
  disableGuildSelect?: boolean
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
  ],
  scopes = ['bot'],
  guildId,
  disableGuildSelect = false,
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

export function isAbortError(error: unknown, signal?: AbortSignal): error is Error {
  return (
    (error instanceof Error &&
      (error.name === 'AbortError' ||
        error.name === 'Aborterror' ||
        error.name === 'aborterror' ||
        error.name.toLowerCase() === 'aborterror' ||
        error.name === 'MessageAbortedError' ||
        error.message?.includes('aborted') ||
        (signal?.aborted ?? false))) ||
    (error instanceof DOMException && error.name === 'AbortError')
  )
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const TIME_DIVISIONS: Array<{ amount: number; name: Intl.RelativeTimeFormatUnit }> = [
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

export function abbreviatePath(fullPath: string): string {
  const home = os.homedir()
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length)
  }
  return fullPath
}
