// Transcription API key button, slash command, and modal handlers.
// Auto-detects provider from key prefix: sk-* = OpenAI, otherwise Gemini.


import { setGeminiApiKey, setOpenAIApiKey } from '../database.js'
import { PLATFORM_MESSAGE_FLAGS } from '../platform/message-flags.js'
import type {
  ButtonEvent,
  CommandEvent,
  ModalSubmitEvent,
  UiModal,
} from '../platform/types.js'

function buildTranscriptionApiKeyModal(appId: string): UiModal {
  return {
    id: `transcription_apikey_modal:${appId}`,
    title: 'Transcription API Key',
    inputs: [
      {
        type: 'text',
        id: 'apikey',
        label: 'OpenAI or Gemini API Key',
        placeholder: 'sk-... or AIza...',
        style: 'short',
        required: true,
      },
    ],
  }
}

export async function handleTranscriptionApiKeyButton(
  interaction: ButtonEvent,
): Promise<void> {
  if (!interaction.customId.startsWith('transcription_apikey:')) return

  const appId = interaction.customId
    .slice('transcription_apikey:'.length)
    .trim()
  if (!appId) {
    await interaction.reply({
      content: 'Missing app id for API key setup.',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  await interaction.showModal(buildTranscriptionApiKeyModal(appId))
}

export async function handleTranscriptionApiKeyCommand({
  interaction,
  appId,
}: {
  interaction: CommandEvent
  appId: string
}): Promise<void> {
  await interaction.showModal(buildTranscriptionApiKeyModal(appId))
}

export async function handleTranscriptionApiKeyModalSubmit(
  interaction: ModalSubmitEvent,
): Promise<void> {
  if (!interaction.customId.startsWith('transcription_apikey_modal:')) return

  const appId = interaction.customId
    .slice('transcription_apikey_modal:'.length)
    .trim()

  await interaction.deferReply({ flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL })

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
