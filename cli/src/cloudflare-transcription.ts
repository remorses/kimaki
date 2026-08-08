// Free Whisper transcription fallback via the kimaki.dev Cloudflare Worker.
// Only usable in gateway mode: the worker authenticates the request against
// the shared gateway_clients Postgres table using the CLI's own
// clientId:clientSecret pair (the same credentials already used for
// gateway-proxy REST/WebSocket calls), then runs
// @cf/openai/whisper-large-v3-turbo on Cloudflare's own Workers AI account.
// This means transcription costs Kimaki, never the user, so voice messages
// work out of the box for gateway-mode installs with no OpenAI/Gemini key
// configured.
//
// See website/src/server.tsx POST /api/transcribe for the server side.
// Rate limits (per-client burst + daily request cap) are enforced there,
// not here — a 429 from the worker just means this fallback is unavailable
// right now and the caller should fall back to the "add API key" dialog.

import { TranscriptionError } from './errors.js'
import { createLogger, LogPrefix } from './logger.js'

const voiceLogger = createLogger(LogPrefix.VOICE)

const KIMAKI_TRANSCRIBE_URL =
  process.env.KIMAKI_TRANSCRIBE_URL || 'https://kimaki.dev/api/transcribe'

export async function transcribeViaKimakiGateway({
  audio,
  mediaType,
  clientId,
  clientSecret,
}: {
  audio: Buffer
  /** Discord attachment content-type (e.g. audio/ogg, audio/mpeg). Defaults
   *  to audio/ogg (Discord voice messages) when not provided. */
  mediaType?: string
  clientId: string
  clientSecret: string
}): Promise<string | TranscriptionError> {
  const response = await fetch(KIMAKI_TRANSCRIBE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientId}:${clientSecret}`,
      'Content-Type': mediaType || 'audio/ogg',
    },
    body: audio,
  }).catch((cause) => {
    return new TranscriptionError({
      reason: 'Failed to reach kimaki.dev transcription endpoint',
      cause,
    })
  })
  if (response instanceof TranscriptionError) return response

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '')
    voiceLogger.log(
      `Kimaki gateway transcription failed: ${response.status} ${bodyText}`,
    )
    return new TranscriptionError({
      reason: `kimaki.dev returned ${response.status}${bodyText ? `: ${bodyText}` : ''}`,
    })
  }

  const data = (await response.json().catch((cause) => {
    return new TranscriptionError({
      reason: 'Failed to parse transcription response',
      cause,
    })
  })) as { text?: string } | TranscriptionError
  if (data instanceof TranscriptionError) return data

  if (!data.text) {
    return new TranscriptionError({
      reason: 'Empty transcription response from kimaki gateway',
    })
  }
  return data.text
}
