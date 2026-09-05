// Voice attachment detection helpers.
// Normalizes Discord attachment heuristics for voice-message detection so
// message routing, transcription, and empty-prompt guards all agree even when
// Discord omits contentType on uploaded audio attachments.
// iOS videos also have duration_secs; reject those before the duration heuristic.

import path from 'node:path'

const VOICE_ATTACHMENT_EXTENSIONS = new Set<string>([
  '.m4a',
  '.mp3',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
])

const VIDEO_ATTACHMENT_EXTENSIONS = new Set<string>([
  '.avi',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.webm',
])

export type VoiceAttachmentLike = {
  contentType?: string | null
  name?: string | null
  duration?: number | null
  waveform?: string | null
  width?: number | null
  height?: number | null
}

function isVisualMediaAttachment(attachment: VoiceAttachmentLike): boolean {
  const contentType = attachment.contentType?.trim().toLowerCase() || ''
  if (contentType.startsWith('video/')) return true

  const extension = path.extname(attachment.name || '').toLowerCase()
  if (VIDEO_ATTACHMENT_EXTENSIONS.has(extension)) return true

  return (
    typeof attachment.width === 'number' &&
    attachment.width > 0 &&
    typeof attachment.height === 'number' &&
    attachment.height > 0
  )
}

export function getVoiceAttachmentMatchReason(
  attachment: VoiceAttachmentLike,
): string | null {
  if (isVisualMediaAttachment(attachment)) return null

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
