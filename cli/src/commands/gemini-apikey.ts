// Transcription API key button, slash command, and modal handlers.
// Auto-detects provider from key prefix: sk-* = OpenAI, otherwise Gemini.

import {
  ActionRowBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js'
import { setGeminiApiKey, setOpenAIApiKey } from '../database.js'

function buildTranscriptionApiKeyModal(appId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`transcription_apikey_modal:${appId}`)
    .setTitle('Transcription API Key')

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
      content:
        'OpenAI API key saved. Voice messages will be transcribed with OpenAI.',
    })
  } else {
    await setGeminiApiKey(appId, apiKey)
    await interaction.editReply({
      content:
        'Gemini API key saved. Voice messages will be transcribed with Gemini.',
    })
  }
}
