// Markdown table formatter for Discord.
// Converts GFM tables to Discord Components V2 (ContainerBuilder with TextDisplay
// key-value pairs and Separators between row groups). Large tables are split
// across multiple Container components to stay within the 40-component limit.

import { Lexer, type Token, type Tokens } from 'marked'
import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacingSize,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInContainer,
  type APIContainerComponent,
  type APITextDisplayComponent,
  type APISeparatorComponent,
  type APIMessageTopLevelComponent,
} from 'discord.js'
import {
  parseInlineHtmlRenderables,
  type HtmlButtonRenderable,
  type HtmlRenderable,
} from './html-components.js'

export type ContentSegment =
  | { type: 'text'; text: string }
  | { type: 'components'; components: APIMessageTopLevelComponent[] }

type TableRenderOptions = {
  resolveButtonCustomId?: ({
    button,
  }: {
    button: HtmlButtonRenderable
  }) => string | Error
}

type RenderedTableCell =
  | { type: 'text'; text: string }
  | {
      type: 'button'
      label: string
      customId: string
      variant: HtmlButtonRenderable['variant']
      disabled: boolean
    }

type RenderedTableRow = {
  components: Array<
    APITextDisplayComponent | APIActionRowComponent<APIButtonComponent>
  >
  componentCost: number
}

type CalloutDescriptor = {
  accentColor?: number
}

// Max 40 components per message (nested components count toward the limit).
// Row cost is dynamic now because a table row can render as a plain TextDisplay
// or as a TextDisplay plus an Action Row holding one or more buttons.
const MAX_COMPONENTS = 40

/**
 * Split markdown into text and table component segments.
 * Tables are rendered as CV2 Container components with bold key-value TextDisplay
 * pairs. Large tables are split across multiple component segments.
 */
export function splitTablesFromMarkdown(
  markdown: string,
  options: TableRenderOptions = {},
): ContentSegment[] {
  const blocks = splitMarkdownByCallouts({ markdown })
  return blocks.flatMap((block) => {
    if (block.type === 'callout') {
      const innerSegments = splitTablesFromMarkdown(block.content, options)
      return buildCalloutSegments({
        segments: innerSegments,
        callout: block.callout,
      })
    }

    return splitTableSegmentsFromText({
      markdown: block.text,
      options,
    })
  })
}

type MarkdownBlock =
  | { type: 'text'; text: string }
  | { type: 'callout'; content: string; callout: CalloutDescriptor }

function splitMarkdownByCallouts({
  markdown,
}: {
  markdown: string
}): MarkdownBlock[] {
  const lines = markdown.match(/.*(?:\n|$)/g)?.filter((line) => {
    return line.length > 0
  }) ?? [markdown]
  const blocks: MarkdownBlock[] = []
  let textBuffer = ''

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const callout = parseCalloutOpenLine({ line })
    if (!callout) {
      textBuffer += line
      continue
    }

    if (textBuffer.length > 0) {
      blocks.push({ type: 'text', text: textBuffer })
      textBuffer = ''
    }

    const body = collectCalloutBodyFromLines({
      lines,
      startIndex: index,
    })
    if (body instanceof Error) {
      textBuffer += line
      continue
    }

    blocks.push({
      type: 'callout',
      content: body.content,
      callout,
    })
    index = body.endIndex
  }

  if (textBuffer.length > 0) {
    blocks.push({ type: 'text', text: textBuffer })
  }

  return blocks
}

function splitTableSegmentsFromText({
  markdown,
  options,
}: {
  markdown: string
  options: TableRenderOptions
}): ContentSegment[] {
  const lexer = new Lexer()
  return splitTokensIntoSegments({
    tokens: lexer.lex(markdown),
    options,
  })
}

function splitTokensIntoSegments({
  tokens,
  options,
}: {
  tokens: Token[]
  options: TableRenderOptions
}): ContentSegment[] {
  const segments: ContentSegment[] = []
  let textBuffer = ''
  const isTableToken = (token: Token): token is Tokens.Table => {
    return (
      token.type === 'table' &&
      Object.hasOwn(token, 'header') &&
      Object.hasOwn(token, 'rows')
    )
  }

  for (const token of tokens) {
    if (isTableToken(token)) {
      if (textBuffer.trim()) {
        segments.push({ type: 'text', text: textBuffer })
        textBuffer = ''
      }
      const componentSegments = buildTableComponents(token, options)
      segments.push(...componentSegments)
    } else {
      textBuffer += token.raw
    }
  }

  if (textBuffer.trim()) {
    segments.push({ type: 'text', text: textBuffer })
  }

  return segments
}

function buildCalloutSegments({
  segments,
  callout,
}: {
  segments: ContentSegment[]
  callout: CalloutDescriptor
}): ContentSegment[] {
  const children = flattenCalloutChildren({ segments })
  if (children.length === 0) {
    return []
  }

  const chunks = chunkCalloutChildrenByComponentLimit({ children })
  return chunks.map((chunk) => {
    const container: APIContainerComponent = {
      type: ComponentType.Container,
      ...(callout.accentColor !== undefined
        ? { accent_color: callout.accentColor }
        : {}),
      components: chunk,
    }
    const components: APIMessageTopLevelComponent[] = [container]
    return {
      type: 'components' as const,
      components,
    }
  })
}

function flattenCalloutChildren({
  segments,
}: {
  segments: ContentSegment[]
}): APIComponentInContainer[] {
  return segments.flatMap((segment) => {
    if (segment.type === 'text') {
      if (!segment.text.trim()) {
        return []
      }
      return [
        {
          type: ComponentType.TextDisplay,
          content: segment.text.trim(),
        } satisfies APITextDisplayComponent,
      ]
    }

    return segment.components.flatMap((component) => {
      if (component.type !== ComponentType.Container) {
        return []
      }
      return component.components
    })
  })
}

function chunkCalloutChildrenByComponentLimit({
  children,
}: {
  children: APIComponentInContainer[]
}): APIComponentInContainer[][] {
  const chunks: APIComponentInContainer[][] = []
  let currentChunk: APIComponentInContainer[] = []

  for (const child of children) {
    if (currentChunk.length > 0 && currentChunk.length + 2 > MAX_COMPONENTS) {
      chunks.push(currentChunk)
      currentChunk = []
    }
    currentChunk.push(child)
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}

function collectCalloutBodyFromLines({
  lines,
  startIndex,
}: {
  lines: string[]
  startIndex: number
}): { content: string; endIndex: number } | Error {
  let depth = 0
  const contentLines: string[] = []

  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index]!
    const nestedCallout = parseCalloutOpenLine({ line })
    if (nestedCallout) {
      if (depth > 0) {
        contentLines.push(line)
      }
      depth += 1
      continue
    }

    if (/^<\/callout>$/i.test(line.trim())) {
      depth -= 1
      if (depth === 0) {
        return {
          content: contentLines.join(''),
          endIndex: index,
        }
      }
      contentLines.push(line)
      continue
    }

    if (depth > 0) {
      contentLines.push(line)
    }
  }

  return new Error('Unclosed <callout> block')
}

function parseCalloutOpenLine({
  line,
}: {
  line: string
}): CalloutDescriptor | null {
  const match = line.trim().match(/^<callout(?:\s+[^>]*)?>$/i)
  if (!match) {
    return null
  }

  const accentValue = line.match(/\baccent=(['"])(.*?)\1/i)?.[2]?.trim()
  const accentColor = accentValue
    ? parseAccentColor({ value: accentValue })
    : undefined

  return {
    accentColor: accentColor instanceof Error ? undefined : accentColor,
  }
}

function parseAccentColor({
  value,
}: {
  value: string
}): number | Error {
  const hex = value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(hex)) {
    return Number.parseInt(hex.slice(1), 16)
  }
  if (/^#[0-9a-f]{3}$/.test(hex)) {
    const expanded = hex
      .slice(1)
      .split('')
      .map((char) => {
        return `${char}${char}`
      })
      .join('')
    return Number.parseInt(expanded, 16)
  }
  if (/^\d+$/.test(hex)) {
    return Number.parseInt(hex, 10)
  }
  return new Error(`Unsupported callout accent color: ${value}`)
}

/**
 * Build CV2 components for a table. Plain rows render as one TextDisplay with
 * bold key-value lines. Rows with resolved button cells render as a TextDisplay
 * plus an Action Row so wide tables do not violate Section's 1-3 text child
 * limit. Large tables are split into multiple Containers using a dynamic
 * component-budget check.
 */
export function buildTableComponents(
  table: Tokens.Table,
  options: TableRenderOptions = {},
): ContentSegment[] {
  const headers = table.header.map((cell) => {
    return extractCellText(cell.tokens)
  })
  const rows = table.rows.map((row) => {
    return buildRenderedRow({
      headers,
      row,
      options,
    })
  })

  const chunks = chunkRowsByComponentLimit({ rows })

  return chunks.map((chunkRows) => {
    const children: Array<
      | APITextDisplayComponent
      | APIActionRowComponent<APIButtonComponent>
      | APISeparatorComponent
    > = []

    for (let i = 0; i < chunkRows.length; i++) {
      if (i > 0) {
        children.push({
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacingSize.Small,
        })
      }
      children.push(...chunkRows[i]!.components)
    }

    const container: APIContainerComponent = {
      type: ComponentType.Container,
      components: children,
    }
    const components: APIMessageTopLevelComponent[] = [container]

    return {
      type: 'components' as const,
      components,
    }
  })
}

function buildRenderedRow({
  headers,
  row,
  options,
}: {
  headers: string[]
  row: Tokens.TableCell[]
  options: TableRenderOptions
}): RenderedTableRow {
  const renderedCells = row.map((cell) => {
    return renderTableCell({ cell, options })
  })
  const buttonCellCount = renderedCells.filter((cell) => {
    return cell.type === 'button'
  }).length

  if (buttonCellCount > 0) {
    return buildButtonRow({
      headers,
      cells: renderedCells,
    })
  }

  return buildTextRow({
    headers,
    cells: renderedCells,
  })
}

function buildTextRow({
  headers,
  cells,
}: {
  headers: string[]
  cells: RenderedTableCell[]
}): RenderedTableRow {
  const lines = headers.map((key, index) => {
    const cell = cells[index]
    const value = cell ? getRenderedCellText({ cell }) : ''
    return `**${key}** ${value}`
  })

  return {
    components: [
      {
        type: ComponentType.TextDisplay,
        content: lines.join('\n'),
      },
    ],
    componentCost: 1,
  }
}

function buildButtonRow({
  headers,
  cells,
}: {
  headers: string[]
  cells: RenderedTableCell[]
}): RenderedTableRow {
  const buttonCells = cells.filter((cell) => {
    return cell.type === 'button'
  })
  if (buttonCells.length === 0 || buttonCells.length > 5) {
    return buildTextRow({ headers, cells })
  }

  const lines = headers.flatMap((header, index) => {
    const cell = cells[index]
    if (!cell || cell.type === 'button') {
      return []
    }

    return [`**${header}** ${cell.text}`]
  })
  if (lines.length === 0) {
    return buildTextRow({ headers, cells })
  }

  const buttons: APIButtonComponent[] = buttonCells.map((buttonCell) => {
    return {
      type: ComponentType.Button,
      custom_id: buttonCell.customId,
      label: buttonCell.label,
      style: toButtonStyle({ variant: buttonCell.variant }),
      disabled: buttonCell.disabled,
    }
  })

  const actionRow: APIActionRowComponent<APIButtonComponent> = {
    type: ComponentType.ActionRow,
    components: buttons,
  }

  return {
    components: [
      {
        type: ComponentType.TextDisplay,
        content: lines.join('\n'),
      },
      actionRow,
    ],
    componentCost: 2 + buttons.length,
  }
}

function chunkRowsByComponentLimit({
  rows,
}: {
  rows: RenderedTableRow[]
}): RenderedTableRow[][] {
  const chunks: RenderedTableRow[][] = []
  let currentChunk: RenderedTableRow[] = []
  let currentCost = 1

  for (const row of rows) {
    const separatorCost = currentChunk.length > 0 ? 1 : 0
    const nextCost = currentCost + separatorCost + row.componentCost

    if (currentChunk.length > 0 && nextCost > MAX_COMPONENTS) {
      chunks.push(currentChunk)
      currentChunk = [row]
      currentCost = 1 + row.componentCost
      continue
    }

    currentChunk.push(row)
    currentCost = nextCost
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}

function renderTableCell({
  cell,
  options,
}: {
  cell: Tokens.TableCell
  options: TableRenderOptions
}): RenderedTableCell {
  const hasHtmlToken = cell.tokens.some((token) => {
    return token.type === 'html'
  })
  if (!hasHtmlToken) {
    return {
      type: 'text',
      text: extractCellText(cell.tokens),
    }
  }

  const renderables = parseInlineHtmlRenderables({ html: cell.text })
  if (renderables instanceof Error) {
    return {
      type: 'text',
      text: extractRenderableText({ renderables: undefined, fallbackText: cell.text }),
    }
  }

  const buttonRenderables = renderables.filter((renderable) => {
    return renderable.type === 'button'
  })
  if (buttonRenderables.length !== 1) {
    return {
      type: 'text',
      text: extractRenderableText({ renderables, fallbackText: cell.text }),
    }
  }

  const hasNonWhitespaceText = renderables.some((renderable) => {
    if (renderable.type !== 'text') {
      return false
    }
    return renderable.text.trim().length > 0
  })
  if (hasNonWhitespaceText) {
    return {
      type: 'text',
      text: extractRenderableText({ renderables, fallbackText: cell.text }),
    }
  }

  const button = buttonRenderables[0]!
  const customId = options.resolveButtonCustomId?.({ button })
  if (!customId || customId instanceof Error) {
    return {
      type: 'text',
      text: button.label,
    }
  }

  return {
    type: 'button',
    label: button.label,
    customId,
    variant: button.variant,
    disabled: button.disabled,
  }
}

function getRenderedCellText({
  cell,
}: {
  cell: RenderedTableCell
}): string {
  if (cell.type === 'button') {
    return cell.label
  }
  return cell.text
}

function extractRenderableText({
  renderables,
  fallbackText,
}: {
  renderables?: HtmlRenderable[]
  fallbackText: string
}): string {
  if (!renderables) {
    return fallbackText.replace(/\s+/g, ' ').trim()
  }

  const text = renderables
    .map((renderable) => {
      if (renderable.type === 'button') {
        return renderable.label
      }
      return renderable.text
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length > 0) {
    return text
  }

  return fallbackText.replace(/\s+/g, ' ').trim()
}

function toButtonStyle({
  variant,
}: {
  variant: HtmlButtonRenderable['variant']
}):
  | ButtonStyle.Primary
  | ButtonStyle.Secondary
  | ButtonStyle.Success
  | ButtonStyle.Danger {
  if (variant === 'primary') {
    return ButtonStyle.Primary
  }
  if (variant === 'success') {
    return ButtonStyle.Success
  }
  if (variant === 'danger') {
    return ButtonStyle.Danger
  }
  return ButtonStyle.Secondary
}

function extractCellText(tokens: Token[]): string {
  const parts: string[] = []
  for (const token of tokens) {
    parts.push(extractTokenText(token))
  }
  return parts.join('').trim()
}

function extractTokenText(token: Token): string {
  switch (token.type) {
    case 'text':
    case 'codespan':
    case 'escape':
      return token.text
    case 'link':
      return token.href
    case 'image':
      return token.href
    case 'strong':
    case 'em':
    case 'del':
      return token.tokens ? extractCellText(token.tokens) : token.text
    case 'br':
      return ' '
    default: {
      const nestedTokens = Reflect.get(token, 'tokens')
      if (Array.isArray(nestedTokens)) {
        return extractCellText(nestedTokens.filter((value): value is Token => {
          return (
            typeof value === 'object' &&
            value !== null &&
            typeof Reflect.get(value, 'type') === 'string'
          )
        }))
      }
      const text = Reflect.get(token, 'text')
      if (typeof text === 'string') {
        return text
      }
      return ''
    }
  }
}
