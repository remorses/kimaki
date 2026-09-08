import type { Message } from 'discord.js'

export function stripMentions(text: string) {
  return text
    .replace(/<@!?\d+>/g, '')
    .replace(/<@&\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function threadNameFromMessage(message: Message) {
  const name = stripMentions(message.content || '').replace(/\s+/g, ' ').trim()
  return (name || 'kimaki thread').slice(0, 80)
}

export function usernameOf(message: Message) {
  return message.member?.displayName || message.author.displayName || message.author.username
}

const DISCORD_CONTENT_MAX = 2000

export function splitDiscordContent(content: string, maxLength = DISCORD_CONTENT_MAX) {
  if (content.length <= maxLength) return [content]
  const chunks: string[] = []
  let remaining = content
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength)
    const breakAt = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '))
    const size = breakAt > maxLength / 2 ? breakAt : maxLength
    chunks.push(remaining.slice(0, size))
    remaining = remaining.slice(size).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}
