// PCM16 helpers: channel downmix, resampling, base64 and WAV. Pure functions, no Web Audio.

import * as errore from 'errore'

export class WavError extends errore.createTaggedError({
  name: 'WavError',
  message: 'Invalid WAV file: $reason',
}) {}

/** Average interleaved channels into mono. */
export function toMono(pcm: Int16Array, channels: number): Int16Array {
  if (channels === 1) return pcm
  const out = new Int16Array(Math.floor(pcm.length / channels))
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += pcm[i * channels + c] ?? 0
    out[i] = Math.round(sum / channels)
  }
  return out
}

/**
 * Resample mono PCM16. Downsampling averages the source window (a box low-pass filter),
 * upsampling interpolates linearly. Good enough for speech.
 */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm
  const ratio = from / to
  const out = new Int16Array(Math.floor(pcm.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const start = i * ratio
    if (ratio > 1) {
      const end = Math.min(pcm.length, Math.floor(start + ratio))
      let sum = 0
      let count = 0
      for (let j = Math.floor(start); j < end; j++) {
        sum += pcm[j] ?? 0
        count++
      }
      out[i] = count === 0 ? 0 : Math.round(sum / count)
      continue
    }
    const index = Math.floor(start)
    const fraction = start - index
    const a = pcm[index] ?? 0
    const b = pcm[index + 1] ?? a
    out[i] = Math.round(a + (b - a) * fraction)
  }
  return out
}

export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function base64ToPcm(base64: string): Int16Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
}

export function silence({ ms, rate }: { ms: number; rate: number }): Int16Array {
  return new Int16Array(Math.round((ms / 1000) * rate))
}

/** Read a PCM16 WAV file. */
export function readWav(bytes: Uint8Array): WavError | { pcm: Int16Array; rate: number; channels: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return new WavError({ reason: 'missing RIFF/WAVE header' })
  let offset = 12
  let format: { rate: number; channels: number; bits: number } | null = null
  while (offset + 8 <= bytes.length) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      }
    }
    if (id === 'data') {
      if (format === null) return new WavError({ reason: 'data chunk before fmt chunk' })
      if (format.bits !== 16) return new WavError({ reason: `${format.bits}-bit audio, expected 16-bit PCM` })
      const end = Math.min(bytes.length, body + size)
      // Copy into a fresh buffer: Node Buffers are views into a shared pool.
      const copy = Uint8Array.from(bytes.subarray(body, end - ((end - body) % 2)))
      return { pcm: new Int16Array(copy.buffer), rate: format.rate, channels: format.channels }
    }
    offset = body + size + (size % 2)
  }
  return new WavError({ reason: 'no data chunk' })
}

/** Encode mono PCM16 as a WAV file. */
export function encodeWav({ pcm, rate }: { pcm: Int16Array; rate: number }): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(out.buffer)
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i)
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44)
  return out
}
