import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'
import type { VoiceConnection } from '@discordjs/voice'
import { VoiceConnectionStatus } from '@discordjs/voice'
import * as prism from 'prism-media'
import { Resampler } from '@purinton/resampler'

// Discord expects Opus packets every 20ms
const FRAME_LENGTH = 20

export interface DirectVoiceStreamer {
  /**
   * Write raw PCM audio data to be streamed to Discord
   * @param pcmData - Raw PCM audio data (s16le format)
   */
  write(pcmData: Buffer): void

  /**
   * Stop streaming and clean up resources
   */
  stop(): void

  /**
   * Clear the current queue without stopping the streamer
   */
  interrupt(): void

  /**
   * Whether the streamer is currently active
   */
  isActive: boolean
}

export function createDirectVoiceStreamer({
  connection,
  inputSampleRate,
  inputChannels,
  onStop,
}: {
  connection: VoiceConnection
  inputSampleRate: number
  inputChannels: number
  onStop?: () => void
}): DirectVoiceStreamer {
  let active = true

  const opusChannels = 2
  // Create resampler to convert input to 48kHz stereo (Discord's format)
  const resampler = new Resampler({
    inRate: inputSampleRate,
    outRate: 48000,
    inChannels: inputChannels,
    volume: 1,
    filterWindow: 8,
    outChannels: opusChannels,
  })
  resampler.on('error', (error) => {
    console.error('[DIRECT VOICE] Resampler error:', error)
  })
  resampler.on('end', () => {
    console.error('[DIRECT VOICE] Resampler end')
  })

  const frameSize = 960 // 20ms at 48kHz (960 samples per frame)
  // Create Opus encoder for Discord (48kHz stereo)
  const encoder = new prism.opus.Encoder({
    rate: 48000,
    channels: opusChannels,
    frameSize,
  })

  // Pipe resampler to encoder
  resampler.pipe(encoder)


  let packetInterval: NodeJS.Timeout | null = null
  const opusPacketQueue: Buffer[] = []

  encoder.on('data', (packet: Buffer) => {
    // Opus encoder outputs complete packets, don't buffer them
    opusPacketQueue.push(packet)
  })

  // Send packets at 20ms intervals as Discord expects
  packetInterval = setInterval(() => {
    if (!active) {
      if (packetInterval) {
        clearInterval(packetInterval)
        packetInterval = null
      }
      return
    }

    const packet = opusPacketQueue.shift()
    if (!packet) return

    if (connection.state.status !== VoiceConnectionStatus.Ready) {
      console.log('[DIRECT VOICE] Skipping packet: connection not ready')
      return
    }

    try {
      connection.setSpeaking(true)
      connection.playOpusPacket(packet)
      console.log('[DIRECT VOICE] Sent Opus packet of size', packet.length)
    } catch (error) {
      console.error('[DIRECT VOICE] Error sending packet:', error)
    }
  }, 20) // 20ms interval

  encoder.on('error', (error) => {
    console.error('[DIRECT VOICE] Encoder error:', error)
  })

  return {
    write(pcmData: Buffer) {
      if (!active) {
        throw new Error('Voice streamer has been stopped')
      }
      resampler.write(pcmData)
    },

    interrupt() {
      // Clear the Opus packet queue
      opusPacketQueue.length = 0

      // Stop speaking immediately
      connection.setSpeaking(false)

      console.log('[DIRECT VOICE] Interrupted - cleared queue')
    },

    stop() {
      if (!active) return

      active = false

      // Stop speaking
      connection.setSpeaking(false)

      // Clear the packet interval
      if (packetInterval) {
        clearInterval(packetInterval)
        packetInterval = null
      }

      // Close the resampler input
      resampler.end()

      onStop?.()
    },

    get isActive() {
      return active
    },
  }
}

// Helper to create a voice streamer that accepts 20ms PCM frames
export function createFramedVoiceStreamer({
  connection,
  inputSampleRate,
  inputChannels,
  frameSize,
  onStop,
}: {
  connection: VoiceConnection
  inputSampleRate: number
  inputChannels: number
  frameSize: number // Expected size in bytes of each 20ms frame
  onStop?: () => void
}): DirectVoiceStreamer {
  const baseStreamer = createDirectVoiceStreamer({
    connection,
    inputSampleRate,
    inputChannels,
    onStop,
  })

  let buffer = Buffer.alloc(0)

  return {
    write(pcmData: Buffer) {
      // Accumulate data
      buffer = Buffer.concat([buffer, pcmData])

      // Write complete frames
      while (buffer.length >= frameSize) {
        const frame = buffer.subarray(0, frameSize)
        buffer = buffer.subarray(frameSize)
        baseStreamer.write(frame)
      }
    },

    interrupt() {
      // Clear the buffer
      buffer = Buffer.alloc(0)
      baseStreamer.interrupt()
    },

    stop() {
      // Write any remaining partial frame
      if (buffer.length > 0) {
        baseStreamer.write(buffer)
      }
      baseStreamer.stop()
    },

    get isActive() {
      return baseStreamer.isActive
    },
  }
}
