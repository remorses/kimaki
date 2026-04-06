// Voice attachment detection helpers.
// Normalizes Discord attachment heuristics for voice-message detection so
// message routing, transcription, and empty-prompt guards all agree even when
// Discord omits contentType on uploaded audio attachments.

import path from 'node:path'

const VOICE_ATTACHMENT_EXTENSIONS = new Set<string>([
  '.m4a',
  '.mp3',
  '.mp4',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
])

export type VoiceAttachmentLike = {
  contentType?: string | null
  name?: string | null
  duration?: number | null
  waveform?: string | null
}

export function getVoiceAttachmentMatchReason(
  attachment: VoiceAttachmentLike,
): string | null {
  const contentType = attachment.contentType?.trim().toLowerCase() || ''
  if (contentType.startsWith('audio/')) {
    return `contentType:${contentType}`
  }

  if (typeof attachment.duration === 'number' && attachment.duration > 0) {
    return `duration:${attachment.duration}`
  }

  if (attachment.waveform?.trim()) {
    return 'waveform'
  }

  const extension = path.extname(attachment.name || '').toLowerCase()
  if (VOICE_ATTACHMENT_EXTENSIONS.has(extension)) {
    return `extension:${extension}`
  }

  return null
}

export function isVoiceAttachment(attachment: VoiceAttachmentLike): boolean {
  return getVoiceAttachmentMatchReason(attachment) !== null
}
