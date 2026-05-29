// Retry-transcription button: attached to every "⚠️ Transcription failed" message
// so users can re-run transcription without manually re-uploading the voice message.
//
// Flow:
//   1. Voice transcription fails → voice-handler.ts posts the failure message with
//      a 🔄 Retry button built by `buildRetryTranscriptionRow`. The customId encodes
//      `retry_transcription:<channelId>:<messageId>` so the handler can re-fetch the
//      original voice attachment from Discord.
//   2. User clicks → `handleRetryTranscriptionButton` defers, refetches the message,
//      and delegates back to `processVoiceAttachment` — which already knows how to
//      post a transcript on success or a fresh failure-with-retry-button on retry.
//
// We deliberately re-use the full voice pipeline (vs. ad-hoc transcribe-only logic)
// so the retry path stays consistent with first-attempt transcription: same project
// context, same agent enum, same session-context awareness, same thread renaming.

import * as errore from 'errore'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Message,
} from 'discord.js'
import { getChannelDirectory } from '../database.js'
import { processVoiceAttachment } from '../voice-handler.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.VOICE)

const CUSTOM_ID_PREFIX = 'retry_transcription:'

/**
 * Build the action row containing a "🔄 Retry transcription" button. Caller is
 * responsible for attaching it to a Discord message (typically the failure notice
 * posted by `processVoiceAttachment`).
 *
 * The customId encodes the source channel + message IDs so the handler can locate
 * the original voice attachment when the user clicks. Discord's customId hard limit
 * is 100 chars — two snowflake IDs (~19 chars each) + prefix fit comfortably.
 */
export function buildRetryTranscriptionRow(
  voiceMessage: Pick<Message, 'id' | 'channelId'>,
): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}${voiceMessage.channelId}:${voiceMessage.id}`)
    .setLabel('Retry transcription')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary)

  return new ActionRowBuilder<ButtonBuilder>().addComponents(button)
}

/**
 * Discord button-click handler for the retry-transcription button.
 * Re-fetches the original voice message and delegates to `processVoiceAttachment`,
 * which posts the transcript (or another failure-with-retry-button) into the thread.
 *
 * Replies to the interaction itself are ephemeral — the user-visible transcription
 * goes to the thread, not the ephemeral reply, so other thread members can see it.
 */
export async function handleRetryTranscriptionButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith(CUSTOM_ID_PREFIX)) return

  const payload = interaction.customId.slice(CUSTOM_ID_PREFIX.length)
  const [channelId, messageId] = payload.split(':')
  if (!channelId || !messageId) {
    await interaction.reply({
      content: '⚠️ Malformed retry button — missing message reference.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // Transcription can take 10+ seconds — defer before doing real work so Discord
  // doesn't time us out at the 3s mark.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const thread = interaction.channel
  if (!thread || !thread.isThread()) {
    await interaction.editReply({
      content: '⚠️ Retry must be triggered from inside the thread that hosted the original transcription.',
    })
    return
  }

  // Fetch the original voice message via the source channel (not the thread).
  // Voice messages live on the parent channel; the thread was spawned alongside.
  const sourceChannel = await errore.tryAsync({
    try: () => interaction.client.channels.fetch(channelId),
    catch: (e) => new Error('channel fetch failed', { cause: e }),
  })
  if (sourceChannel instanceof Error || !sourceChannel) {
    await interaction.editReply({
      content: `⚠️ Could not access the source channel: ${sourceChannel instanceof Error ? sourceChannel.message : 'channel not found'}`,
    })
    return
  }
  if (!sourceChannel.isTextBased()) {
    await interaction.editReply({
      content: '⚠️ Source channel does not support messages.',
    })
    return
  }

  const sourceMessage = await errore.tryAsync({
    try: () => sourceChannel.messages.fetch(messageId),
    catch: (e) => new Error('message fetch failed', { cause: e }),
  })
  if (sourceMessage instanceof Error) {
    await interaction.editReply({
      content: `⚠️ Could not fetch the original voice message (it may have been deleted): ${sourceMessage.message}`,
    })
    return
  }

  // Best-effort project directory lookup so the retry path keeps the same project
  // context (file tree, agents) the first attempt had. Falls back to no context
  // if the channel is not registered.
  const parentChannelId = thread.parentId
  const projectConfig = parentChannelId
    ? await getChannelDirectory(parentChannelId)
    : undefined
  const projectDirectory = projectConfig?.directory

  const appId = interaction.client.application?.id

  logger.log(
    `Retry button clicked for message ${messageId} in channel ${channelId} (thread ${thread.id})`,
  )

  await interaction.editReply({
    content: '🔄 Retrying transcription… result will appear in the thread.',
  })

  // Hand off to the canonical voice pipeline. It will:
  //   - post its own "🎤 Transcribing voice message…" status into the thread
  //   - either succeed (post the transcript) or fail again (post a fresh
  //     failure message with another retry button attached)
  const result = await processVoiceAttachment({
    message: sourceMessage,
    thread,
    ...(projectDirectory ? { projectDirectory } : {}),
    ...(appId ? { appId } : {}),
  })

  if (result === null) {
    // The voice pipeline already posted a detailed error in the thread, so the
    // ephemeral reply just acknowledges it.
    await interaction.editReply({
      content: '⚠️ Retry failed. See the thread message for details — you can click Retry again to try once more.',
    })
    return
  }

  await interaction.editReply({
    content: '✅ Transcription succeeded — posted in the thread.',
  })
}
