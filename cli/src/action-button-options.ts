// kimaki_action_buttons option types, validation and message content.
// Shared by the OpenCode plugin (tool execute) and the bot (IPC row check),
// so it must stay free of discord.js and other bot-only imports.

import * as errore from 'errore'

// Discord button label limit.
export const ACTION_BUTTON_LABEL_MAX = 80
// Discord message content limit. The button message shows every command.
const DISCORD_MESSAGE_MAX = 2000
export const ACTION_BUTTON_COLORS = ['white', 'blue', 'green', 'red'] as const

export type ActionButtonColor = (typeof ACTION_BUTTON_COLORS)[number]

export type ActionButtonOption = {
  label: string
  /** Shell command run on click. label is display text only. */
  command?: string
  color?: ActionButtonColor
}

export class ActionButtonsValidationError extends errore.createTaggedError({
  name: 'ActionButtonsValidationError',
}) {}

function escapeDiscordMarkdown(text: string): string {
  return text.replace(/[\\*_~`|[\]()<>@#]/g, '\\$&')
}

/**
 * Content of the button message. Shows each command before the click, so
 * the user sees what will run. Lives here so validation can check its length.
 */
export function formatActionButtonsContent(buttons: ActionButtonOption[]): string {
  const commandLines = buttons.flatMap((button) => {
    if (button.command === undefined) return []
    // A ``` inside the command would close the code block early.
    const command = button.command.replaceAll('```', '`\u200b``')
    return [`**${escapeDiscordMarkdown(button.label)}** runs:\n\`\`\`sh\n${command}\n\`\`\``]
  })
  return ['**Action Required**', ...commandLines].join('\n')
}

/**
 * Validate raw kimaki_action_buttons args. Used by the plugin execute() and
 * again by the bot when it reads the IPC row. Never truncates.
 */
export function parseActionButtons(
  raw: unknown,
): ActionButtonsValidationError | ActionButtonOption[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 3) {
    return new ActionButtonsValidationError({
      message: 'buttons must be an array of 1-3 buttons.',
    })
  }
  const buttons: ActionButtonOption[] = []
  for (const [index, value] of raw.entries()) {
    const name = `button ${index + 1}`
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return new ActionButtonsValidationError({ message: `${name} must be an object.` })
    }
    const { label: rawLabel, command: rawCommand, color }: Record<string, unknown> =
      Object.fromEntries(Object.entries(value))
    const label = typeof rawLabel === 'string' ? rawLabel.trim() : ''
    if (!label) {
      return new ActionButtonsValidationError({ message: `${name} needs a non-empty label.` })
    }
    if (label.length > ACTION_BUTTON_LABEL_MAX) {
      return new ActionButtonsValidationError({
        message: `${name} label is ${label.length} chars, max ${ACTION_BUTTON_LABEL_MAX}. Use a short label and put any shell command in "command".`,
      })
    }
    // Never trim the command: trailing whitespace can matter to the shell.
    if (rawCommand !== undefined && (typeof rawCommand !== 'string' || !rawCommand.trim())) {
      return new ActionButtonsValidationError({ message: `${name} command must be a non-empty string.` })
    }
    const command = typeof rawCommand === 'string' ? rawCommand : undefined
    const validColor = ACTION_BUTTON_COLORS.find((c) => c === color)
    if (color !== undefined && !validColor) {
      return new ActionButtonsValidationError({
        message: `${name} color must be one of ${ACTION_BUTTON_COLORS.join(', ')}.`,
      })
    }
    buttons.push({ label, command, color: validColor })
  }
  const contentLength = formatActionButtonsContent(buttons).length
  if (contentLength > DISCORD_MESSAGE_MAX) {
    return new ActionButtonsValidationError({
      message: `button message with all commands is ${contentLength} chars, max ${DISCORD_MESSAGE_MAX}. Write long commands to a script file and use a command like "sh /tmp/script.sh".`,
    })
  }
  return buttons
}
