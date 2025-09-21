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

function getRequiredBotPermissions(): bigint[] {
  return [
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
  ]
}

function getPermissionNames(): string[] {
  const permissions = getRequiredBotPermissions()
  const permissionsBitField = new PermissionsBitField(permissions)
  return permissionsBitField.toArray()
}