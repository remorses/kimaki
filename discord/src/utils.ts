import type { Part } from '@opencode-ai/sdk'
import { AttachmentBuilder, EmbedBuilder } from 'discord.js'

function truncate(text?: string, max = 1800): string {
  if (!text) return ' '
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function formatAsCode(jsonLike: unknown, max = 1800): string {
  let body: string
  try {
    body = JSON.stringify(jsonLike, null, 2)
  } catch {
    body = String(jsonLike)
  }
  body = truncate(body, max)
  return '```json\n' + body + '\n```'
}

function renderTextPart(embed: EmbedBuilder, part: Part) {
  if (part.type === 'text') {
    const text = truncate(part.text)
    if (!text) return
    embed.setColor('Purple')
    embed.setDescription(text)
  }
}

function renderReasoningPart(embed: EmbedBuilder, part: Part) {
  if (part.type === 'reasoning') {
    const text = truncate(part.text)
    if (!text) return
    embed.setColor('Grey')
    embed.setTitle('Reasoning')
    embed.setDescription(text)
  }
}

function renderToolPart(embed: EmbedBuilder, part: Part) {
  if (part.type === 'tool') {
    // If status is "pending", "running", or "completed", state.title is optional and can be undefined.
    // For error or other use, we don't show text in the embed content directly, but we truncate fields as well for status messages.
    // However, part.text is not standard for "tool" so doesn't apply to every situation, but keeping the pattern.
    // If specific check on text is required for tool, adjust as needed.
    embed.setColor('Orange')
    embed.setTitle(truncate(`Tool: ${part.tool}`, 256))

    if (part.state.status === 'pending') {
      embed.setDescription('Pending...')
    } else if (part.state.status === 'running') {
      const runningText = truncate(part.state.title || 'Running...')
      if (!runningText) return
      embed.setDescription(runningText)
      if (part.state.input) {
        embed.addFields({
          name: 'Input',
          value: formatAsCode(part.state.input, 1000),
        })
      }
    } else if (part.state.status === 'completed') {
      const completedText = truncate(part.state.title || 'Completed')
      if (!completedText) return
      embed.setDescription(completedText)
      if (part.state.input) {
        embed.addFields({
          name: 'Input',
          value: formatAsCode(part.state.input, 1000),
        })
      }
      if (part.state.output) {
        const outputText = truncate(part.state.output, 1000)
        if (!outputText) return
        embed.addFields({ name: 'Output', value: outputText })
      }
    } else if (part.state.status === 'error') {
      embed.setColor('Red')
      embed.setDescription('Error')
      if (part.state.error) {
        const errorText = truncate(part.state.error, 1000)
        if (!errorText) return
        embed.addFields({ name: 'Error', value: errorText })
      }
    }
  }
}

function renderFilePart(embed: EmbedBuilder, part: Part) {
  if (part.type === 'file') {
    const text = truncate(part.filename)
    if (!text) return
    embed.setColor('Blue')
    embed.setTitle(part.filename || 'File')
    embed.setDescription(`Type: ${part.mime}`)
    if (part.url) {
      embed.setURL(part.url)
    }
  }
}

export function messageToEmbed(parts: Part[]): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = []

  for (const part of parts) {
    const embed = new EmbedBuilder()

    switch (part.type) {
      case 'text':
        renderTextPart(embed, part)
        embeds.push(embed)
        break
      case 'reasoning':
        renderReasoningPart(embed, part)
        embeds.push(embed)
        break
      case 'tool':
        renderToolPart(embed, part)
        embeds.push(embed)
        break
      case 'file':
        renderFilePart(embed, part)
        embeds.push(embed)
        break
      // Skip other part types we don't need to render
      case 'snapshot':
      case 'patch':
      case 'agent':
      case 'step-start':
      case 'step-finish':
        break
    }
  }

  return embeds
}

type DiscordPayload = { embeds: EmbedBuilder[]; files: AttachmentBuilder[] }

export function userContentToDiscord(content: string | Part[]): DiscordPayload {
  const embeds: EmbedBuilder[] = []
  const files: AttachmentBuilder[] = []

  if (typeof content === 'string') {
    const e = new EmbedBuilder()
    const text = truncate(content)
    if (!text) return { embeds, files }
    e.setColor('Blue')
    e.setDescription(text)
    embeds.push(e)
    return { embeds, files }
  }

  // If it's an array of parts, use messageToEmbed
  if (Array.isArray(content)) {
    const partsEmbeds = messageToEmbed(content)
    embeds.push(...partsEmbeds)
  }

  return { embeds, files }
}
