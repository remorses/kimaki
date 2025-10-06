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

export function isAbortError(
  error: unknown,
  signal?: AbortSignal,
): error is Error {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'Aborterror' ||
      error.name === 'aborterror' ||
      error.name.toLowerCase() === 'aborterror' ||
      error.message?.includes('aborted') ||
      (signal?.aborted ?? false))
  )
}
