// Markdown table formatter for Discord.
// Converts GFM tables to Discord Components V2 (ContainerBuilder with TextDisplay
// key-value pairs and Separators between row groups). Large tables are split
// across multiple Container components to stay within the 40-component limit.

import { Lexer, type Token, type Tokens } from 'marked'
import {
  PLATFORM_BUTTON_STYLE,
  PLATFORM_COMPONENT_TYPE,
  PLATFORM_SEPARATOR_SPACING,
  type PlatformActionRowComponent,
  type PlatformButtonComponent,
  type PlatformContainerComponent,
  type PlatformTextDisplayComponent,
  type PlatformSeparatorComponent,
  type PlatformMessageTopLevelComponent,
} from './platform/components-v2.js'
import {
  parseInlineHtmlRenderables,
  type HtmlButtonRenderable,
  type HtmlRenderable,
} from './html-components.js'

export type ContentSegment =
  | { type: 'text'; text: string }
  | { type: 'components'; components: PlatformMessageTopLevelComponent[] }

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
  components: Array<PlatformTextDisplayComponent | PlatformActionRowComponent>
  componentCost: number
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
  const lexer = new Lexer()
  const tokens = lexer.lex(markdown)
  const segments: ContentSegment[] = []
  let textBuffer = ''

  for (const token of tokens) {
    if (token.type === 'table') {
      if (textBuffer.trim()) {
        segments.push({ type: 'text', text: textBuffer })
        textBuffer = ''
      }
      const componentSegments = buildTableComponents(token as Tokens.Table, options)
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
      | PlatformTextDisplayComponent
      | PlatformActionRowComponent
      | PlatformSeparatorComponent
    > = []

    for (let i = 0; i < chunkRows.length; i++) {
      if (i > 0) {
        children.push({
          type: PLATFORM_COMPONENT_TYPE.SEPARATOR,
          divider: true,
          spacing: PLATFORM_SEPARATOR_SPACING.SMALL,
        })
      }
      children.push(...chunkRows[i]!.components)
    }

    const container: PlatformContainerComponent = {
      type: PLATFORM_COMPONENT_TYPE.CONTAINER,
      components: children,
    }

    return {
      type: 'components' as const,
      components: [container] as PlatformMessageTopLevelComponent[],
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
          type: PLATFORM_COMPONENT_TYPE.TEXT_DISPLAY,
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

  const buttons: PlatformButtonComponent[] = buttonCells.map((buttonCell) => {
    return {
      type: PLATFORM_COMPONENT_TYPE.BUTTON,
      custom_id: buttonCell.customId,
      label: buttonCell.label,
      style: toButtonStyle({ variant: buttonCell.variant }),
      disabled: buttonCell.disabled,
    }
  })

  const actionRow: PlatformActionRowComponent = {
    type: PLATFORM_COMPONENT_TYPE.ACTION_ROW,
    components: buttons,
  }

  return {
    components: [
        {
          type: PLATFORM_COMPONENT_TYPE.TEXT_DISPLAY,
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
  | typeof PLATFORM_BUTTON_STYLE.PRIMARY
  | typeof PLATFORM_BUTTON_STYLE.SECONDARY
  | typeof PLATFORM_BUTTON_STYLE.SUCCESS
  | typeof PLATFORM_BUTTON_STYLE.DANGER {
  if (variant === 'primary') {
    return PLATFORM_BUTTON_STYLE.PRIMARY
  }
  if (variant === 'success') {
    return PLATFORM_BUTTON_STYLE.SUCCESS
  }
  if (variant === 'danger') {
    return PLATFORM_BUTTON_STYLE.DANGER
  }
  return PLATFORM_BUTTON_STYLE.SECONDARY
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
      const tokenAny = token as { tokens?: Token[]; text?: string }
      if (tokenAny.tokens && Array.isArray(tokenAny.tokens)) {
        return extractCellText(tokenAny.tokens)
      }
      if (typeof tokenAny.text === 'string') {
        return tokenAny.text
      }
      return ''
    }
  }
}
