// Shared types for command handlers.

import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
} from 'discord.js'

export type CommandContext = {
  command: ChatInputCommandInteraction
  appId: string
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>

export type AutocompleteContext = {
  interaction: AutocompleteInteraction
  appId: string
}

export type AutocompleteHandler = (ctx: AutocompleteContext) => Promise<void>

export type SelectMenuHandler = (interaction: StringSelectMenuInteraction) => Promise<void>
