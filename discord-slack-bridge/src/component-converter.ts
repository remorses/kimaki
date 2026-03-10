// Converts Discord message components to Slack Block Kit blocks.
//
// Supported Discord components:
//   ActionRow → actions block (contains buttons/selects)
//   Button    → button element (primary/danger/secondary styles)
//   StringSelect/UserSelect/RoleSelect/MentionableSelect/ChannelSelect
//             → Slack select elements (best-effort for role/mentionable)
//   TextDisplay  → section block (mrkdwn) — Components V2
//   Section      → section block with accessory — Components V2
//   Container    → pass through children — Components V2
//   Separator    → divider block — Components V2
//
// Discord uses nested ActionRow > [Button | Select] structure.
// Slack uses actions block > [button | static_select] structure.
// The mapping is nearly 1:1.

import crypto from 'node:crypto'
import {
  ComponentType,
  ButtonStyle,
  ChannelType,
} from 'discord-api-types/v10'
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIButtonComponentWithCustomId,
  APIButtonComponentWithURL,
  APIStringSelectComponent,
  APIUserSelectComponent,
  APIRoleSelectComponent,
  APIMentionableSelectComponent,
  APIChannelSelectComponent,
  APISelectMenuDefaultValue,
  SelectMenuDefaultValueType,
  APISelectMenuOption,
  APITextDisplayComponent,
  APISectionComponent,
  APIContainerComponent,
  APIComponentInMessageActionRow,
} from 'discord-api-types/v10'
import { markdownToMrkdwn } from './format-converter.js'
import { encodeComponentActionId } from './component-id-codec.js'

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
  type:
    | 'static_select'
    | 'multi_static_select'
    | 'users_select'
    | 'multi_users_select'
    | 'conversations_select'
    | 'multi_conversations_select'
  action_id: string
  placeholder?: SlackTextObject
  options?: SlackOptionObject[]
  initial_option?: SlackOptionObject
  initial_options?: SlackOptionObject[]
  initial_user?: string
  initial_users?: string[]
  initial_conversation?: string
  initial_conversations?: string[]
  max_selected_items?: number
  filter?: {
    include?: Array<'public' | 'private' | 'im' | 'mpim'>
    exclude_external_shared_channels?: boolean
    exclude_bot_users?: boolean
  }
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
      continue
    }

    const select = convertSelect(child)
    if (select) {
      elements.push(select)
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
    const actionId = `link_${crypto
      .createHash('sha256')
      .update(linkBtn.url)
      .digest('hex')
      .slice(0, 32)}`

    return {
      type: 'button',
      action_id: actionId,
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

function convertSelect(
  component: APIComponentInMessageActionRow,
): SlackSelectElement | null {
  if (component.type === ComponentType.StringSelect) {
    return convertStringSelect(component as APIStringSelectComponent)
  }
  if (component.type === ComponentType.UserSelect) {
    return convertUserSelect(component as APIUserSelectComponent)
  }
  if (component.type === ComponentType.ChannelSelect) {
    return convertChannelSelect(component as APIChannelSelectComponent)
  }
  if (component.type === ComponentType.MentionableSelect) {
    return convertMentionableSelect(component as APIMentionableSelectComponent)
  }
  if (component.type === ComponentType.RoleSelect) {
    return convertRoleSelect(component as APIRoleSelectComponent)
  }
  return null
}

function convertStringSelect(select: APIStringSelectComponent): SlackSelectElement | null {
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
    type: select.max_values && select.max_values > 1
      ? 'multi_static_select'
      : 'static_select',
    action_id: encodeComponentActionId({
      componentType: ComponentType.StringSelect,
      customId: select.custom_id,
    }),
    options,
  }

  if (select.placeholder) {
    result.placeholder = {
      type: 'plain_text',
      text: select.placeholder,
    }
  }

  if (initialOption) {
    if (result.type === 'multi_static_select') {
      result.initial_options = [initialOption]
    } else {
      result.initial_option = initialOption
    }
  }

  if (result.type === 'multi_static_select') {
    result.max_selected_items = select.max_values ?? 1
  }

  return result
}

function convertUserSelect(select: APIUserSelectComponent): SlackSelectElement {
  const isMulti = (select.max_values ?? 1) > 1
  const defaultUsers = (select.default_values ?? [])
    .filter((value) => {
      return value.type === 'user'
    })
    .map((value) => {
      return value.id
    })

  const result: SlackSelectElement = {
    type: isMulti ? 'multi_users_select' : 'users_select',
    action_id: encodeComponentActionId({
      componentType: ComponentType.UserSelect,
      customId: select.custom_id,
    }),
  }

  if (select.placeholder) {
    result.placeholder = {
      type: 'plain_text',
      text: select.placeholder,
    }
  }

  if (isMulti) {
    result.max_selected_items = select.max_values ?? 1
    if (defaultUsers.length > 0) {
      result.initial_users = defaultUsers
    }
    return result
  }

  if (defaultUsers[0]) {
    result.initial_user = defaultUsers[0]
  }
  return result
}

function convertChannelSelect(select: APIChannelSelectComponent): SlackSelectElement {
  const isMulti = (select.max_values ?? 1) > 1
  const defaultChannels = (select.default_values ?? [])
    .filter((value) => {
      return value.type === 'channel'
    })
    .map((value) => {
      return value.id
    })

  const result: SlackSelectElement = {
    type: isMulti
      ? 'multi_conversations_select'
      : 'conversations_select',
    action_id: encodeComponentActionId({
      componentType: ComponentType.ChannelSelect,
      customId: select.custom_id,
    }),
    filter: {
      include: discordChannelTypesToSlackFilter(select.channel_types ?? []),
      exclude_external_shared_channels: false,
      exclude_bot_users: true,
    },
  }

  if (select.placeholder) {
    result.placeholder = {
      type: 'plain_text',
      text: select.placeholder,
    }
  }

  if (isMulti) {
    result.max_selected_items = select.max_values ?? 1
    if (defaultChannels.length > 0) {
      result.initial_conversations = defaultChannels
    }
    return result
  }

  if (defaultChannels[0]) {
    result.initial_conversation = defaultChannels[0]
  }
  return result
}

function convertMentionableSelect(select: APIMentionableSelectComponent): SlackSelectElement {
  const isMulti = (select.max_values ?? 1) > 1
  const defaultUsers = (select.default_values ?? [])
    .filter((value) => {
      return value.type === 'user'
    })
    .map((value) => {
      return value.id
    })

  const result: SlackSelectElement = {
    type: isMulti ? 'multi_users_select' : 'users_select',
    action_id: encodeComponentActionId({
      componentType: ComponentType.MentionableSelect,
      customId: select.custom_id,
    }),
  }

  if (select.placeholder) {
    result.placeholder = {
      type: 'plain_text',
      text: select.placeholder,
    }
  }

  if (isMulti) {
    result.max_selected_items = select.max_values ?? 1
    if (defaultUsers.length > 0) {
      result.initial_users = defaultUsers
    }
    return result
  }

  if (defaultUsers[0]) {
    result.initial_user = defaultUsers[0]
  }
  return result
}

function convertRoleSelect(select: APIRoleSelectComponent): SlackSelectElement {
  const roleDefaults = (select.default_values ?? []).filter((value) => {
    return value.type === 'role'
  })
  const noRolesOption: SlackOptionObject = {
    text: { type: 'plain_text', text: 'No roles available', emoji: true },
    value: '__no_roles_available__',
    description: {
      type: 'plain_text',
      text: 'Slack has no role picker; this bridge uses role IDs when available.',
    },
  }
  const options = roleDefaults.length > 0
    ? roleDefaults.map((value) => {
        return defaultRoleValueToOption(value)
      })
    : [noRolesOption]
  const isMulti = (select.max_values ?? 1) > 1

  const result: SlackSelectElement = {
    type: isMulti ? 'multi_static_select' : 'static_select',
    action_id: encodeComponentActionId({
      componentType: ComponentType.RoleSelect,
      customId: select.custom_id,
    }),
    options,
  }

  if (select.placeholder) {
    result.placeholder = {
      type: 'plain_text',
      text: select.placeholder,
    }
  }

  if (isMulti) {
    result.max_selected_items = select.max_values ?? 1
    result.initial_options = options.slice(0, Math.max(0, select.min_values ?? 0))
    return result
  }

  if (options[0]) {
    result.initial_option = options[0]
  }
  return result
}

function defaultRoleValueToOption(
  value: APISelectMenuDefaultValue<SelectMenuDefaultValueType.Role>,
): SlackOptionObject {
  return {
    text: {
      type: 'plain_text',
      text: `Role ${value.id}`,
      emoji: true,
    },
    value: value.id,
  }
}

function discordChannelTypesToSlackFilter(
  channelTypes: ChannelType[],
): Array<'public' | 'private' | 'im' | 'mpim'> {
  if (channelTypes.length === 0) {
    return ['public', 'private']
  }

  const include = new Set<'public' | 'private' | 'im' | 'mpim'>()
  const privateThreadTypes = new Set<ChannelType>([
    ChannelType.PrivateThread,
  ])
  const publicThreadTypes = new Set<ChannelType>([
    ChannelType.PublicThread,
    ChannelType.AnnouncementThread,
  ])

  for (const channelType of channelTypes) {
    if (channelType === ChannelType.DM) {
      include.add('im')
      continue
    }
    if (channelType === ChannelType.GroupDM) {
      include.add('mpim')
      continue
    }
    if (privateThreadTypes.has(channelType)) {
      include.add('private')
      continue
    }
    if (publicThreadTypes.has(channelType)) {
      include.add('public')
      continue
    }
    include.add('public')
    include.add('private')
  }

  return include.size > 0 ? [...include] : ['public', 'private']
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
