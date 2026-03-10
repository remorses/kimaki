// Platform-level message flag constants shared by command/runtime code.
// Keep Discord SDK enums inside adapters and expose numeric protocol flags here.

export const PLATFORM_MESSAGE_FLAGS = {
  SUPPRESS_EMBEDS: 1 << 2,
  EPHEMERAL: 1 << 6,
  SUPPRESS_NOTIFICATIONS: 1 << 12,
  IS_COMPONENTS_V2: 1 << 15,
} as const
