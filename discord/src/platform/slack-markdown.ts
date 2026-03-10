// Slack markdown and Block Kit helpers for Kimaki's platform adapter.
// Converts Kimaki outgoing messages into Slack mrkdwn sections plus interactive
// action blocks for buttons and select menus.

import type {
  OutgoingMessage,
  UiButton,
  UiButtonStyle,
  UiSelectMenu,
} from './types.js'

type SlackButtonElement = {
  type: 'button'
  action_id: string
  text: {
    type: 'plain_text'
    text: string
    emoji: boolean
  }
  style?: 'danger' | 'primary'
  value: string
}

type SlackSelectOption = {
  text: {
    type: 'plain_text'
    text: string
    emoji: boolean
  }
  value: string
  description?: {
    type: 'plain_text'
    text: string
    emoji: boolean
  }
}

type SlackSelectPlaceholder = {
  type: 'plain_text'
  text: string
  emoji: boolean
}

type SlackStaticSelectElement = {
  type: 'static_select'
  action_id: string
  placeholder: SlackSelectPlaceholder
  options: SlackSelectOption[]
}

type SlackMultiStaticSelectElement = {
  type: 'multi_static_select'
  action_id: string
  placeholder: SlackSelectPlaceholder
  options: SlackSelectOption[]
  max_selected_items?: number
}

type SlackSectionBlock = {
  type: 'section'
  text: {
    type: 'mrkdwn'
    text: string
  }
}

type SlackActionsBlock = {
  type: 'actions'
  elements: Array<
    SlackButtonElement | SlackStaticSelectElement | SlackMultiStaticSelectElement
  >
}

export type SlackBlocks = Array<SlackSectionBlock | SlackActionsBlock>

const MAX_SECTION_TEXT_LENGTH = 3000
const MAX_BLOCK_COUNT = 50
const MAX_BUTTON_TEXT_LENGTH = 75
const MAX_OPTION_TEXT_LENGTH = 75
const MAX_PLACEHOLDER_TEXT_LENGTH = 150

function truncate({ value, maxLength }: { value: string; maxLength: number }) {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength - 1)}…`
}

function normalizeMarkdown(markdown: string) {
  return markdown
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>')
}

function splitMrkdwnSections(markdown: string) {
  const normalized = normalizeMarkdown(markdown).trim()
  if (!normalized) {
    return []
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => {
      return paragraph.trim()
    })
    .filter((paragraph) => {
      return paragraph.length > 0
    })

  const chunks: string[] = []
  for (const paragraph of paragraphs) {
    if (paragraph.length <= MAX_SECTION_TEXT_LENGTH) {
      chunks.push(paragraph)
      continue
    }

    let remaining = paragraph
    while (remaining.length > 0) {
      const nextChunk = remaining.slice(0, MAX_SECTION_TEXT_LENGTH)
      chunks.push(nextChunk)
      remaining = remaining.slice(MAX_SECTION_TEXT_LENGTH).trimStart()
    }
  }

  return chunks
}

function toSlackButtonStyle(style?: UiButtonStyle) {
  if (style === 'primary' || style === 'success') {
    return 'primary' as const
  }
  if (style === 'danger') {
    return 'danger' as const
  }
  return undefined
}

function buildButtonElement(button: UiButton) {
  return {
    type: 'button' as const,
    action_id: button.id,
    text: {
      type: 'plain_text' as const,
      text: truncate({
        value: button.label,
        maxLength: MAX_BUTTON_TEXT_LENGTH,
      }),
      emoji: true,
    },
    style: toSlackButtonStyle(button.style),
    value: button.id,
  }
}

function buildSelectMenuElement(selectMenu: UiSelectMenu) {
  const options = selectMenu.options.map((option) => {
    return {
      text: {
        type: 'plain_text' as const,
        text: truncate({
          value: option.label,
          maxLength: MAX_OPTION_TEXT_LENGTH,
        }),
        emoji: true,
      },
      value: option.value,
      description: option.description
        ? {
            type: 'plain_text' as const,
            text: truncate({
              value: option.description,
              maxLength: MAX_OPTION_TEXT_LENGTH,
            }),
            emoji: true,
          }
        : undefined,
    }
  })
  const placeholder = {
    type: 'plain_text' as const,
    text: truncate({
      value: selectMenu.placeholder || 'Select an option',
      maxLength: MAX_PLACEHOLDER_TEXT_LENGTH,
    }),
    emoji: true,
  }

  if ((selectMenu.maxValues ?? 1) > 1) {
    return {
      type: 'multi_static_select' as const,
      action_id: selectMenu.id,
      placeholder,
      options,
      max_selected_items: selectMenu.maxValues,
    }
  }

  return {
    type: 'static_select' as const,
    action_id: selectMenu.id,
    placeholder,
    options,
  }
}

function buildActionBlocks(message: OutgoingMessage): SlackBlocks {
  const blocks: SlackBlocks = []

  const buttons = message.buttons || []
  if (buttons.length > 0) {
    blocks.push({
      type: 'actions',
      elements: buttons.slice(0, 5).map((button) => {
        return buildButtonElement(button)
      }),
    })
  }

  const selectMenus = [message.selectMenu, ...(message.selectMenus || [])].filter(
    (value): value is UiSelectMenu => {
      return Boolean(value)
    },
  )
  for (const selectMenu of selectMenus) {
    blocks.push({
      type: 'actions',
      elements: [buildSelectMenuElement(selectMenu)],
    })
  }

  return blocks
}

export function renderSlackMessage(message: OutgoingMessage): {
  text: string
  blocks: SlackBlocks
} {
  const sections = splitMrkdwnSections(message.markdown)
  const text = normalizeMarkdown(message.markdown).trim() || ' '
  const sectionBlocks: SlackBlocks = sections.map((section) => {
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: section,
      },
    }
  })
  const actionBlocks = buildActionBlocks(message)
  const blocks = [...sectionBlocks, ...actionBlocks].slice(0, MAX_BLOCK_COUNT)

  if (blocks.length === 0) {
    return {
      text,
      blocks: [],
    }
  }

  return {
    text,
    blocks,
  }
}
