// Segments -> Discord message payloads. Text segments are classic content
// messages. Tables and callouts become Components V2 containers: one
// TextDisplay per table row ("**Header** value" lines) with a Separator
// between rows. Limits: 40 components and 4000 text chars per message, so
// big tables and callouts spill into more messages with the same accent.
// https://discord.com/developers/docs/components/reference

import {
  ComponentType,
  MessageFlags,
  type APIContainerComponent,
  type APISeparatorComponent,
  type APITextDisplayComponent,
} from 'discord.js'

import { renderMarkdown, type Segment, type TableSegment, type TextSegment } from './render-markdown.ts'

const MAX_COMPONENTS = 40
const MAX_TEXT_CHARS = 4000

export type DiscordPayload =
  | { content: string }
  | { flags: MessageFlags.IsComponentsV2; components: APIContainerComponent[] }

type Child = APITextDisplayComponent | APISeparatorComponent

function textDisplay(content: string): APITextDisplayComponent {
  return { type: ComponentType.TextDisplay, content }
}

const separator: APISeparatorComponent = { type: ComponentType.Separator }

function tableRows(table: TableSegment): string[] {
  return table.rows.map((row) =>
    row
      .map((cell, index) => {
        const header = table.header[index]
        return header ? `**${header}** ${cell}` : cell
      })
      .join('\n'),
  )
}

// A TextDisplay holds at most MAX_TEXT_CHARS; longer rows use several.
function textDisplays(content: string): APITextDisplayComponent[] {
  return Array.from({ length: Math.max(1, Math.ceil(content.length / MAX_TEXT_CHARS)) }, (_, index) =>
    textDisplay(content.slice(index * MAX_TEXT_CHARS, (index + 1) * MAX_TEXT_CHARS)),
  )
}

function children(segments: Array<TextSegment | TableSegment>): Child[][] {
  // Groups that must stay together; separators go between table rows.
  return segments.flatMap((segment) => {
    if (segment.kind === 'text') return textDisplays(segment.markdown).map((display) => [display])
    return tableRows(segment).flatMap((row, index) =>
      textDisplays(row).map((display, part) => (index > 0 && part === 0 ? [separator, display] : [display])),
    )
  })
}

function textLength(group: Child[]): number {
  return group.reduce((sum, child) => sum + (child.type === ComponentType.TextDisplay ? child.content.length : 0), 0)
}

// Packs child groups into containers within the per-message budgets.
function containers({ groups, accent }: { groups: Child[][]; accent?: number }): DiscordPayload[] {
  if (groups.length === 0) return []
  const messages: Child[][] = [[]]
  for (const group of groups) {
    const current = messages[messages.length - 1]!
    const count = current.length + group.length + 1
    const chars = textLength(current) + textLength(group)
    if (current.length > 0 && (count > MAX_COMPONENTS || chars > MAX_TEXT_CHARS)) {
      messages.push(group[0]?.type === ComponentType.Separator ? group.slice(1) : [...group])
      continue
    }
    current.push(...group)
  }
  return messages.map((components) => ({
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        ...(accent !== undefined && { accent_color: accent }),
        components,
      },
    ],
  }))
}

export function segmentPayloads(segments: Segment[]): DiscordPayload[] {
  return segments.flatMap((segment): DiscordPayload[] => {
    if (segment.kind === 'text') return [{ content: segment.markdown }]
    if (segment.kind === 'table') return containers({ groups: children([segment]) })
    return containers({ groups: children(segment.segments), accent: segment.accent })
  })
}

// Model markdown -> Discord messages, in order.
export function markdownPayloads(markdown: string): DiscordPayload[] {
  return segmentPayloads(renderMarkdown(markdown))
}
