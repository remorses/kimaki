// Shared types for command handlers.

import type {
  AutocompleteEvent,
  CommandEvent,
  SelectMenuEvent,
} from '../platform/types.js'

export type CommandContext = {
  command: CommandEvent
  appId: string
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>

export type AutocompleteContext = {
  interaction: AutocompleteEvent
  appId: string
}

export type AutocompleteHandler = (ctx: AutocompleteContext) => Promise<void>

export type SelectMenuHandler = (
  interaction: SelectMenuEvent,
) => Promise<void>
