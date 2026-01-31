import {
  ActionRowBuilder,
  ButtonInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import { setGeminiApiKey } from '../database.js'

export async function handleGeminiApiKeyButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('gemini_apikey:')) {
    return
  }

  const appId = customId.replace('gemini_apikey:', '').trim()
  if (!appId) {
    await interaction.reply({
      content: 'Missing app id for Gemini API key setup.',
      ephemeral: true,
    })
    return
  }

  const modal = new ModalBuilder()
    .setCustomId(`gemini_apikey_modal:${appId}`)
    .setTitle('Gemini API Key')

  const apiKeyInput = new TextInputBuilder()
    .setCustomId('apikey')
    .setLabel('Gemini API Key')
    .setPlaceholder('AIza...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)

  const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(apiKeyInput)
  modal.addComponents(actionRow)

  await interaction.showModal(modal)
}

export async function handleGeminiApiKeyModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('gemini_apikey_modal:')) {
    return
  }

  await interaction.deferReply({ ephemeral: true })

  const appId = customId.replace('gemini_apikey_modal:', '').trim()
  if (!appId) {
    await interaction.editReply({
      content: 'Missing app id for Gemini API key setup.',
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

  await setGeminiApiKey(appId, apiKey)

  await interaction.editReply({
    content: 'Gemini API key saved. Voice messages can be transcribed now.',
  })
}
