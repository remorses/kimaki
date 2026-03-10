// Discord REST route builders used outside the discord adapter.
// Keeps route strings centralized so non-adapter modules don't import discord.js Routes.

function encodePart(value: string): string {
  return encodeURIComponent(value)
}

export const discordRoutes = {
  channel(channelId: string): string {
    return `/channels/${channelId}`
  },
  channelMessages(channelId: string): string {
    return `/channels/${channelId}/messages`
  },
  channelMessageOwnReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): string {
    return `/channels/${channelId}/messages/${messageId}/reactions/${encodePart(emoji)}/@me`
  },
  threads(channelId: string, messageId: string): string {
    return `/channels/${channelId}/messages/${messageId}/threads`
  },
  threadMembers(threadId: string, userId: string): string {
    return `/channels/${threadId}/thread-members/${userId}`
  },
  applicationCommands(appId: string): string {
    return `/applications/${appId}/commands`
  },
  applicationCommand(appId: string, commandId: string): string {
    return `/applications/${appId}/commands/${commandId}`
  },
  applicationGuildCommands(appId: string, guildId: string): string {
    return `/applications/${appId}/guilds/${guildId}/commands`
  },
}
