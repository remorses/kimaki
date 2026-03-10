// Converts Discord message components to Slack Block Kit blocks.
//
// Supported Discord components:
//   ActionRow → actions block (contains buttons/selects)
//   Button    → button element (primary/danger/secondary styles)
//   StringSelect → static_select element
//   TextDisplay  → section block (mrkdwn) — Components V2
//   Section      → section block with accessory — Components V2
//   Container    → pass through children — Components V2
//   Separator    → divider block — Components V2
//
// Discord uses nested ActionRow > [Button | Select] structure.
// Slack uses actions block > [button | static_select] structure.
// The mapping is nearly 1:1.

import {
  ComponentType,
  ButtonStyle,
} from 'discord-api-types/v10'
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIButtonComponentWithCustomId,
  APIButtonComponentWithURL,
  APIStringSelectComponent,
  APISelectMenuOption,
  APITextDisplayComponent,
  APISectionComponent,
  APIContainerComponent,
  APISeparatorComponent,
  APIComponentInMessageActionRow,
} from 'discord-api-types/v10'
import { markdownToMrkdwn } from './format-converter.js'

// Slack Block Kit types (output)

export interface SlackBlock {
  type: string
  block_id?: string
  [key: string]: unknown
}

interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn'
  text: string
  emoji?: boolean
}

interface SlackButtonElement {
  type: 'button'
  action_id: string
  text: SlackTextObject
  value?: string
  style?: 'primary' | 'danger'
  url?: string
}

interface SlackOptionObject {
  text: SlackTextObject
  value: string
  description?: SlackTextObject
}

interface SlackSelectElement {
  type: 'static_select'
  action_id: string
  placeholder?: SlackTextObject
  options: SlackOptionObject[]
  initial_option?: SlackOptionObject
}

/**
 * Convert an array of Discord message components to Slack Block Kit blocks.
 * Returns empty array if no components or all components are unsupported.
 */
export function componentsToBlocks(
  components: unknown[],
): SlackBlock[] {
  if (!components || components.length === 0) {
    return []
  }

  const blocks: SlackBlock[] = []

  for (const component of components) {
    const comp = component as { type: number }
    const converted = convertComponent(comp)
    blocks.push(...converted)
  }

  return blocks
}

function convertComponent(component: { type: number }): SlackBlock[] {
  switch (component.type) {
    case ComponentType.ActionRow: {
      return convertActionRow(
        component as APIActionRowComponent<APIComponentInMessageActionRow>,
      )
    }
    case ComponentType.TextDisplay: {
      return convertTextDisplay(component as APITextDisplayComponent)
    }
    case ComponentType.Section: {
      return convertSection(component as APISectionComponent)
    }
    case ComponentType.Container: {
      return convertContainer(component as APIContainerComponent)
    }
    case ComponentType.Separator: {
      return [{ type: 'divider' }]
    }
    default: {
      return []
    }
  }
}

// ---- ActionRow (contains buttons and selects) ----

function convertActionRow(
  row: APIActionRowComponent<APIComponentInMessageActionRow>,
): SlackBlock[] {
  const elements: (SlackButtonElement | SlackSelectElement)[] = []

  for (const child of row.components) {
    if (child.type === ComponentType.Button) {
      const btn = convertButton(child as APIButtonComponent)
      if (btn) {
        elements.push(btn)
      }
    } else if (child.type === ComponentType.StringSelect) {
      const sel = convertStringSelect(child as APIStringSelectComponent)
      if (sel) {
        elements.push(sel)
      }
    }
  }

  if (elements.length === 0) {
    return []
  }

  return [
    {
      type: 'actions',
      elements,
    },
  ]
}

// ---- Button ----

function convertButton(
  button: APIButtonComponent,
): SlackButtonElement | null {
  // Link buttons have a URL, no custom_id
  if (button.style === ButtonStyle.Link) {
    const linkBtn = button as APIButtonComponentWithURL
    return {
      type: 'button',
      action_id: `link_${linkBtn.url}`,
      text: {
        type: 'plain_text',
        text: labelFromButton(button),
        emoji: true,
      },
      url: linkBtn.url,
    }
  }

  // Premium/SKU buttons not supported in Slack
  if (button.style === ButtonStyle.Premium) {
    return null
  }

  // Interactive buttons with custom_id
  const interactiveBtn = button as APIButtonComponentWithCustomId
  const slackStyle = (() => {
    if (
      button.style === ButtonStyle.Primary ||
      button.style === ButtonStyle.Success
    ) {
      return 'primary' as const
    }
    if (button.style === ButtonStyle.Danger) {
      return 'danger' as const
    }
    return undefined
  })()

  return {
    type: 'button',
    action_id: interactiveBtn.custom_id,
    text: {
      type: 'plain_text',
      text: labelFromButton(button),
      emoji: true,
    },
    value: interactiveBtn.custom_id,
    style: slackStyle,
  }
}

function labelFromButton(button: APIButtonComponent): string {
  if ('label' in button && typeof button.label === 'string') {
    return button.label
  }
  // Fallback for emoji-only buttons
  if ('emoji' in button && button.emoji) {
    const emoji = button.emoji as { name?: string }
    return emoji.name ?? 'button'
  }
  return 'button'
}

// ---- StringSelect ----

function convertStringSelect(
  select: APIStringSelectComponent,
): SlackSelectElement | null {
  const options: SlackOptionObject[] = select.options.map(
    (opt: APISelectMenuOption) => {
      const slackOpt: SlackOptionObject = {
        text: {
          type: 'plain_text',
          text: opt.label,
          emoji: true,
        },
        value: opt.value,
      }
      if (opt.description) {
        slackOpt.description = {
          type: 'plain_text',
          text: opt.description,
        }
      }
      return slackOpt
    },
  )

  if (options.length === 0) {
    return null
  }

  const defaultOption = select.options.find((o) => {
    return o.default === true
  })
  const initialOption = defaultOption
    ? options.find((o) => {
        return o.value === defaultOption.value
      })
    : undefined

  const result: SlackSelectElement = {
    type: 'static_select',
    action_id: select.custom_id,
    options,
  }

  if (select.placeholder) {
    result.placeholder = {
      type: 'plain_text',
      text: select.placeholder,
    }
  }

  if (initialOption) {
    result.initial_option = initialOption
  }

  return result
}

// ---- Components V2: TextDisplay ----

function convertTextDisplay(
  component: APITextDisplayComponent,
): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: markdownToMrkdwn(component.content),
      },
    },
  ]
}

// ---- Components V2: Section ----

function convertSection(
  component: APISectionComponent,
): SlackBlock[] {
  // Section has 1-3 text components + optional accessory (button or thumbnail)
  const textParts = component.components
    .map((c) => {
      return (c as APITextDisplayComponent).content
    })
    .join('\n')

  const block: SlackBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: markdownToMrkdwn(textParts),
    },
  }

  // Add accessory if it's a button
  if (
    component.accessory &&
    component.accessory.type === ComponentType.Button
  ) {
    const btn = convertButton(component.accessory as APIButtonComponent)
    if (btn) {
      block.accessory = btn
    }
  }

  return [block]
}

// ---- Components V2: Container ----

function convertContainer(
  component: APIContainerComponent,
): SlackBlock[] {
  // Container is a wrapper — just convert its children
  const children = (component as { components?: unknown[] }).components ?? []
  const blocks: SlackBlock[] = []
  for (const child of children) {
    const comp = child as { type: number }
    blocks.push(...convertComponent(comp))
  }
  return blocks
}
