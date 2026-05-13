// Audio API key button, slash command, and modal handlers.
// Used for both transcription and speech generation — same OpenAI/Gemini keys.
// Auto-detects provider from key prefix: sk-* = OpenAI, otherwise Gemini.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  ModalBuilder,
  type ModalSubmitInteraction,
  type ThreadChannel,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js'
import { setGeminiApiKey, setOpenAIApiKey } from '../database.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'

function buildTranscriptionApiKeyModal(appId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`transcription_apikey_modal:${appId}`)
    .setTitle('Audio API Key')

  const apiKeyInput = new TextInputBuilder()
    .setCustomId('apikey')
    .setLabel('OpenAI or Gemini API Key')
    .setPlaceholder('sk-... or AIza...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)

  const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(
    apiKeyInput,
  )
  modal.addComponents(actionRow)
  return modal
}

/**
 * Show a "Set API Key" button in a Discord thread.
 * Reusable for both transcription and TTS — both use the same stored keys.
 * The button opens a modal where the user can enter an OpenAI or Gemini key.
 */
export async function showApiKeyRequiredButton({
  thread,
  appId,
  message,
}: {
  thread: ThreadChannel
  appId: string
  /** Custom message explaining why a key is needed */
  message?: string
}): Promise<void> {
  const button = new ButtonBuilder()
    .setCustomId(`transcription_apikey:${appId}`)
    .setLabel('Set API Key')
    .setStyle(ButtonStyle.Primary)

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button)

  await thread.send({
    content: message || 'An API key (OpenAI or Gemini) is required. Set one to continue.',
    components: [row],
    flags: SILENT_MESSAGE_FLAGS,
  })
}

export async function handleTranscriptionApiKeyButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('transcription_apikey:')) return

  const appId = interaction.customId
    .slice('transcription_apikey:'.length)
    .trim()
  if (!appId) {
    await interaction.reply({
      content: 'Missing app id for API key setup.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.showModal(buildTranscriptionApiKeyModal(appId))
}

export async function handleTranscriptionApiKeyCommand({
  interaction,
  appId,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  await interaction.showModal(buildTranscriptionApiKeyModal(appId))
}

export async function handleTranscriptionApiKeyModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('transcription_apikey_modal:')) return

  const appId = interaction.customId
    .slice('transcription_apikey_modal:'.length)
    .trim()

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!appId) {
    await interaction.editReply({
      content: 'Missing app id for API key setup.',
    })
    return
  }

  const apiKey = interaction.fields.getTextInputValue('apikey').trim()
  if (!apiKey) {
    await interaction.editReply({
      content: 'API key is required.',
    })
    return
  }

  // Auto-detect provider from key prefix
  if (apiKey.startsWith('sk-')) {
    await setOpenAIApiKey(appId, apiKey)
    await interaction.editReply({
      content: 'OpenAI API key saved. Voice transcription and speech generation are now enabled.',
    })
  } else {
    await setGeminiApiKey(appId, apiKey)
    await interaction.editReply({
      content: 'Gemini API key saved. Voice transcription and speech generation are now enabled.',
    })
  }
}
