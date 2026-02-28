// Converters from Prisma DB rows to Discord API object shapes.
// Uses discord-api-types for return types. Return type annotations enforce
// type safety -- the compiler rejects missing/wrong fields. We avoid blanket
// `as Type` casts which silently bypass that checking.
//
// Exceptions where `as` is still used (each documented inline):
// - APIChannel return: union type that can't be satisfied without knowing
//   the concrete channel variant at compile time
// - APIMessage return: has many optional fields set conditionally
// - JSON.parse results: returns `any`, needs a type annotation
//
// For enum bitfield "zero" values (no flags set), we use a small helper
// that keeps the cast localized to one place.

import {
  GuildMemberFlags,
  GuildSystemChannelFlags,
  Locale,
  RoleFlags,
  ThreadMemberFlags,
} from 'discord-api-types/v10'
import type {
  APIUser,
  APIGuild,
  APIChannel,
  APIMessage,
  APIGuildMember,
  APIRole,
  APIThreadMember,
  GuildFeature,
} from 'discord-api-types/v10'
import type {
  User,
  Guild,
  Channel,
  Message,
  GuildMember,
  Role,
  ThreadMember,
} from './generated/client.js'

// Discord bitfield enums don't include 0 as a member, but 0 is a valid
// value meaning "no flags set". This helper keeps the cast in one place.
function noFlags<T>(): T {
  return 0 as T
}

// Format a Date as ISO 8601 with +00:00 offset instead of Z.
// Twilight's timestamp parser rejects the Z suffix due to minimum length checks.
export function isoTimestamp(date: Date): string {
  return date.toISOString().replace('Z', '+00:00')
}

export function userToAPI(user: User): APIUser {
  return {
    id: user.id,
    username: user.username,
    discriminator: user.discriminator,
    avatar: user.avatar,
    bot: user.bot,
    system: user.system,
    flags: user.flags,
    global_name: user.globalName,
    // mfa_enabled is required by twilight when deserializing the READY payload.
    mfa_enabled: false,
  } as APIUser
}

export function roleToAPI(role: Role): APIRole {
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    position: role.position,
    permissions: role.permissions,
    managed: role.managed,
    mentionable: role.mentionable,
    flags: role.flags ? RoleFlags.InPrompt : noFlags<RoleFlags>(),
    icon: undefined,
    unicode_emoji: undefined,
  }
}

export function channelToAPI(channel: Channel): APIChannel {
  // APIChannel is a discriminated union of 12 channel types keyed by `type`.
  // We build the shape generically because the concrete variant is only
  // known at runtime. The `as APIChannel` cast is justified -- it's a
  // single-hop cast on an object that has all the fields discord.js reads.
  const isThread =
    channel.type === 10 || channel.type === 11 || channel.type === 12

  const base = {
    id: channel.id,
    type: channel.type,
    guild_id: channel.guildId ?? undefined,
    name: channel.name ?? undefined,
    topic: channel.topic ?? undefined,
    parent_id: channel.parentId ?? undefined,
    position: channel.position,
    last_message_id: channel.lastMessageId ?? undefined,
    rate_limit_per_user: channel.rateLimitPerUser,
    ...(isThread
      ? {
          owner_id: channel.ownerId ?? undefined,
          message_count: channel.messageCount,
          member_count: channel.memberCount,
          total_message_sent: channel.totalMessageSent,
          thread_metadata: {
            archived: channel.archived,
            auto_archive_duration: channel.autoArchiveDuration,
            archive_timestamp: (
              channel.archiveTimestamp ?? channel.createdAt
            ).toISOString().replace('Z', '+00:00'),
            locked: channel.locked,
          },
        }
      : {}),
  }

  return base as APIChannel
}

export function memberToAPI(
  member: GuildMember & { user: User },
): APIGuildMember {
  return {
    user: userToAPI(member.user),
    nick: member.nick ?? undefined,
    roles: JSON.parse(member.roles) as string[],
    joined_at: isoTimestamp(member.joinedAt),
    deaf: member.deaf,
    mute: member.mute,
    flags: noFlags<GuildMemberFlags>(),
  }
}

export function guildToAPI(guild: Guild & { roles: Role[] }): APIGuild {
  return {
    id: guild.id,
    name: guild.name,
    icon: guild.icon,
    splash: null,
    discovery_splash: null,
    owner_id: guild.ownerId,
    afk_channel_id: null,
    afk_timeout: 300,
    verification_level: 0,
    default_message_notifications: 0,
    explicit_content_filter: 0,
    roles: guild.roles.map(roleToAPI),
    emojis: [],
    features: JSON.parse(guild.features) as GuildFeature[],
    mfa_level: 0,
    application_id: null,
    system_channel_id: null,
    system_channel_flags: noFlags<GuildSystemChannelFlags>(),
    rules_channel_id: null,
    vanity_url_code: null,
    description: guild.description,
    banner: null,
    premium_tier: 0,
    preferred_locale: Locale.EnglishUS,
    public_updates_channel_id: null,
    nsfw_level: 0,
    premium_progress_bar_enabled: false,
    safety_alerts_channel_id: null,
    stickers: [],
    // hub_type, incidents_data, region are missing in Gelbpunkt/twilight 0.16
    // used by the gateway-proxy main branch. Our remorses/twilight 0.16-updated
    // fork ignores unknown struct fields, so these are safe to include.
    region: '',
    hub_type: null,
    incidents_data: null,
  }
}

export function messageToAPI(
  message: Message,
  author: User,
  guildId?: string,
  member?: GuildMember & { user: User },
): APIMessage {
  // Build with all required fields in the literal, then spread optional
  // fields conditionally. The `as APIMessage` at the end is needed because
  // the optional fields (guild_id, member, webhook_id, etc.) aren't part
  // of the literal's inferred type when their conditions are false.
  const base = {
    id: message.id,
    channel_id: message.channelId,
    author: userToAPI(author),
    content: message.content,
    timestamp: isoTimestamp(message.timestamp),
    edited_timestamp: message.editedTimestamp ? isoTimestamp(message.editedTimestamp) : null,
    tts: message.tts,
    mention_everyone: message.mentionEveryone,
    mentions: [] as APIUser[],
    mention_roles: JSON.parse(message.mentionRoles) as string[],
    attachments: JSON.parse(message.attachments),
    embeds: JSON.parse(message.embeds),
    pinned: message.pinned,
    type: message.type,
    ...(message.flags ? { flags: message.flags } : {}),
    ...(message.components && message.components !== '[]'
      ? { components: JSON.parse(message.components) }
      : {}),
    ...(guildId ? { guild_id: guildId } : {}),
    ...(member
      ? (() => {
          const { user: _u, ...partialMember } = memberToAPI(member)
          return { member: partialMember }
        })()
      : {}),
    ...(message.nonce ? { nonce: message.nonce } : {}),
    ...(message.webhookId ? { webhook_id: message.webhookId } : {}),
    ...(message.applicationId ? { application_id: message.applicationId } : {}),
    ...(message.messageReference
      ? { message_reference: JSON.parse(message.messageReference) }
      : {}),
  }

  return base as APIMessage
}

export function threadMemberToAPI(tm: ThreadMember): APIThreadMember {
  return {
    id: tm.channelId,
    user_id: tm.userId,
    join_timestamp: isoTimestamp(tm.joinedAt),
    flags: noFlags<ThreadMemberFlags>(),
  }
}
