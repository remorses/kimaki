import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js'
import { setChannelAgent, setChannelModel, setSessionAgent, setSessionModel } from './database.js'
import { InvalidModelShortcutError } from './errors.js'
import { resolveAgentCommandContext } from './commands/agent.js'
import { handleQuickPrompt } from './commands/quick-prompt.js'

export type ModelShortcut = {
  name: string
  model: string
  defaultVariant?: string
  variants: string[]
}

const DISCORD_COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
const DISCORD_STRING_CHOICE_MAX_LENGTH = 100

export function parseModelShortcuts(values: string[]): ModelShortcut[] | InvalidModelShortcutError {
  const shortcuts: ModelShortcut[] = []
  const names = new Set<string>()

  for (const rawValue of values) {
    const value = rawValue.trim()
    const equalsIndex = value.indexOf('=')
    if (equalsIndex <= 0 || equalsIndex === value.length - 1) {
      return new InvalidModelShortcutError({
        value: rawValue,
        reason: 'expected name=provider/model[,default-effort[,allowed-effort...]]',
      })
    }

    const name = value.slice(0, equalsIndex).trim()
    if (!DISCORD_COMMAND_NAME_PATTERN.test(name)) {
      return new InvalidModelShortcutError({
        value: rawValue,
        reason:
          'name must be 1-32 lowercase letters, numbers, or hyphens and cannot start with a hyphen',
      })
    }
    if (
      name.endsWith('-agent') ||
      name.endsWith('-cmd') ||
      name.endsWith('-skill') ||
      name.endsWith('-mcp-prompt')
    ) {
      return new InvalidModelShortcutError({
        value: rawValue,
        reason: 'name uses a suffix reserved for existing Kimaki commands',
      })
    }
    if (names.has(name)) {
      return new InvalidModelShortcutError({
        value: rawValue,
        reason: `duplicate command name ${name}`,
      })
    }

    const targetParts = value
      .slice(equalsIndex + 1)
      .split(',')
      .map((part) => part.trim())
    const model = targetParts[0] || ''
    const defaultVariant = targetParts[1] || undefined
    const variants = targetParts.slice(2)
    const [providerId, ...modelParts] = model.split('/')
    if (!providerId || modelParts.join('/').length === 0) {
      return new InvalidModelShortcutError({
        value: rawValue,
        reason: 'model must use the provider/model format',
      })
    }
    if (targetParts.length > 1 && !defaultVariant) {
      return new InvalidModelShortcutError({
        value: rawValue,
        reason: 'default effort cannot be empty',
      })
    }
    if (variants.some((variant) => !variant)) {
      return new InvalidModelShortcutError({
        value: rawValue,
        reason: 'allowed efforts cannot be empty',
      })
    }
    const configuredVariants = defaultVariant ? [defaultVariant, ...variants] : variants
    if (configuredVariants.some((variant) => variant.length > DISCORD_STRING_CHOICE_MAX_LENGTH)) {
      return new InvalidModelShortcutError({
        value: rawValue,
        reason: 'effort names must be at most 100 characters',
      })
    }
    if (new Set(variants).size !== variants.length) {
      return new InvalidModelShortcutError({
        value: rawValue,
        reason: 'allowed efforts cannot contain duplicates',
      })
    }
    if (variants.length > 25) {
      return new InvalidModelShortcutError({
        value: rawValue,
        reason: 'Discord supports at most 25 allowed effort choices',
      })
    }
    if (defaultVariant && variants.length > 0 && !variants.includes(defaultVariant)) {
      return new InvalidModelShortcutError({
        value: rawValue,
        reason: 'default effort must be included in the allowed efforts',
      })
    }

    names.add(name)
    shortcuts.push({
      name,
      model,
      variants,
      ...(defaultVariant ? { defaultVariant } : {}),
    })
  }

  return shortcuts
}

export async function handleModelShortcutCommand({
  interaction,
  appId,
  shortcut,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
  shortcut: ModelShortcut
}): Promise<void> {
  const requestedVariant = interaction.options.getString('effort')?.trim()
  if (
    requestedVariant &&
    shortcut.variants.length > 0 &&
    !shortcut.variants.includes(requestedVariant)
  ) {
    await interaction.reply({
      content: `Unsupported effort \`${requestedVariant}\` for \`${shortcut.model}\``,
      flags: MessageFlags.Ephemeral,
    })
    return
  }
  const variant = requestedVariant || shortcut.defaultVariant || null
  const prompt = interaction.options.getString('prompt')?.trim()
  if (prompt) {
    await handleQuickPrompt({
      command: interaction,
      appId,
      prompt,
      displayLabel: shortcut.name,
      confirmationLabel: `**${shortcut.name}** model`,
      threadReason: `${shortcut.name} model prompt`,
      agent: 'build',
      model: shortcut.model,
      variant,
    })
    return
  }

  await interaction.deferReply()
  const context = await resolveAgentCommandContext({ interaction, appId })
  if (!context) return

  if (context.isThread) {
    if (!context.sessionId) {
      await interaction.editReply({
        content: 'This thread is not linked to an OpenCode session',
      })
      return
    }
    await setSessionAgent(context.sessionId, 'build')
    await setSessionModel({
      sessionId: context.sessionId,
      modelId: shortcut.model,
      variant,
    })
  } else {
    await setChannelAgent(context.channelId, 'build')
    await setChannelModel({
      channelId: context.channelId,
      modelId: shortcut.model,
      variant,
    })
  }

  const scope = context.isThread ? 'this thread' : 'this channel'
  const variantText = variant ? ` with effort \`${variant}\`` : ''
  await interaction.editReply({
    content: `Model for ${scope} set to \`${shortcut.model}\`${variantText}`,
  })
}
