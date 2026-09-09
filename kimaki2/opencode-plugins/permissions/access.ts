import { GuildMember, PermissionsBitField } from 'discord.js'

export function canUseKimaki(interaction: {
  member:
    | GuildMember
    | { permissions: string | bigint | PermissionsBitField; roles?: unknown }
    | null
  user: { id: string }
  guild: {
    ownerId: string
    roles: { cache: { get(id: string): { name: string } | undefined } }
  } | null
}) {
  const member = interaction.member
  if (!member) return false
  const userId = interaction.user.id
  const ownerId = interaction.guild?.ownerId
  if (ownerId && userId === ownerId) return true
  const permissions =
    member instanceof GuildMember
      ? member.permissions
      : new PermissionsBitField(BigInt(member.permissions.toString()))
  if (permissions.has(PermissionsBitField.Flags.Administrator)) return true
  if (permissions.has(PermissionsBitField.Flags.ManageGuild)) return true
  if (member instanceof GuildMember) {
    return member.roles.cache.some((role) => role.name.toLowerCase() === 'kimaki')
  }
  const guild = interaction.guild
  if (!guild || !Array.isArray(member.roles)) return false
  return member.roles.some(
    (roleId) => typeof roleId === 'string' && guild.roles.cache.get(roleId)?.name.toLowerCase() === 'kimaki',
  )
}

export function canReplyToPermission(interaction: {
  member:
    | GuildMember
    | { permissions: string | bigint | PermissionsBitField; roles?: unknown }
    | null
  user: { id: string }
  guild: {
    ownerId: string
    roles: { cache: { get(id: string): { name: string } | undefined } }
  } | null
}) {
  return canUseKimaki(interaction)
}
