// Platform-level Discord Components V2 constants and structural types.
// Keeps Discord numeric protocol details out of command/render modules.

export const PLATFORM_COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  TEXT_DISPLAY: 10,
  SEPARATOR: 14,
  CONTAINER: 17,
} as const

export const PLATFORM_BUTTON_STYLE = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
  LINK: 5,
} as const

export const PLATFORM_SEPARATOR_SPACING = {
  SMALL: 1,
  LARGE: 2,
} as const

export type PlatformButtonStyleValue =
  (typeof PLATFORM_BUTTON_STYLE)[keyof typeof PLATFORM_BUTTON_STYLE]

export type PlatformSeparatorSpacingValue =
  (typeof PLATFORM_SEPARATOR_SPACING)[keyof typeof PLATFORM_SEPARATOR_SPACING]

export type PlatformButtonComponent = {
  type: typeof PLATFORM_COMPONENT_TYPE.BUTTON
  custom_id: string
  label: string
  style: PlatformButtonStyleValue
  disabled?: boolean
}

export type PlatformActionRowComponent = {
  type: typeof PLATFORM_COMPONENT_TYPE.ACTION_ROW
  components: PlatformButtonComponent[]
}

export type PlatformTextDisplayComponent = {
  type: typeof PLATFORM_COMPONENT_TYPE.TEXT_DISPLAY
  content: string
}

export type PlatformSeparatorComponent = {
  type: typeof PLATFORM_COMPONENT_TYPE.SEPARATOR
  divider?: boolean
  spacing?: PlatformSeparatorSpacingValue
}

export type PlatformContainerComponent = {
  type: typeof PLATFORM_COMPONENT_TYPE.CONTAINER
  components: Array<
    | PlatformTextDisplayComponent
    | PlatformActionRowComponent
    | PlatformSeparatorComponent
  >
}

export type PlatformMessageTopLevelComponent =
  | PlatformContainerComponent
  | PlatformTextDisplayComponent
  | PlatformActionRowComponent
