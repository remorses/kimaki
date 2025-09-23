import { parentPort, threadId } from 'node:worker_threads'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Resampler } from '@purinton/resampler'
import * as prism from 'prism-media'
import { startGenAiSession } from './genai.js'
import { getTools } from './tools.js'
import type {
  WorkerInMessage,
  WorkerOutMessage,
} from './worker-types.js'
import type { Session } from '@google/genai'

if (!parentPort) {
  throw new Error('This module must be run as a worker thread')
}

console.log(`[WORKER ${threadId}] GenAI worker started`)

// Audio configuration
const AUDIO_CONFIG = {
  inputSampleRate: 24000, // GenAI output
  inputChannels: 1,
  outputSampleRate: 48000, // Discord expects
  outputChannels: 2,
  opusFrameSize: 960, // 20ms at 48kHz
}

// Initialize audio processing components
const resampler = new Resampler({
  inRate: AUDIO_CONFIG.inputSampleRate,
  outRate: AUDIO_CONFIG.outputSampleRate,
  inChannels: AUDIO_CONFIG.inputChannels,
  outChannels: AUDIO_CONFIG.outputChannels,
  volume: 1,
  filterWindow: 8,
})

const opusEncoder = new prism.opus.Encoder({
  rate: AUDIO_CONFIG.outputSampleRate,
  channels: AUDIO_CONFIG.outputChannels,
  frameSize: AUDIO_CONFIG.opusFrameSize,
})

// Pipe resampler to encoder
resampler.pipe(opusEncoder)

// Opus packet queue and interval for 20ms packet sending
const opusPacketQueue: Buffer[] = []
let packetInterval: NodeJS.Timeout | null = null

// Send packets every 20ms
function startPacketSending() {
  if (packetInterval) return

  packetInterval = setInterval(() => {
    const packet = opusPacketQueue.shift()
    if (!packet) return

    // Transfer packet as ArrayBuffer
    const arrayBuffer = packet.buffer.slice(
      packet.byteOffset,
      packet.byteOffset + packet.byteLength
    ) as ArrayBuffer

    parentPort!.postMessage(
      {
        type: 'assistantOpusPacket',
        packet: arrayBuffer,
      } satisfies WorkerOutMessage,
      [arrayBuffer] // Transfer ownership
    )
  }, 20)
}

function stopPacketSending() {
  if (packetInterval) {
    clearInterval(packetInterval)
    packetInterval = null
  }
  opusPacketQueue.length = 0
}

// Session state
let session: { session: Session; stop: () => void } | null = null

// Audio log stream for assistant audio
let audioLogStream: WriteStream | null = null

// Create assistant audio log stream for debugging
async function createAssistantAudioLogStream(
  guildId: string,
  channelId: string
): Promise<WriteStream | null> {
  if (!process.env.DEBUG) return null

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const audioDir = path.join(process.cwd(), 'discord-audio-logs', guildId, channelId)

  try {
    await mkdir(audioDir, { recursive: true })

    // Create stream for assistant audio (24kHz mono s16le PCM)
    const outputFileName = `assistant_${timestamp}.24.pcm`
    const outputFilePath = path.join(audioDir, outputFileName)
    const outputAudioStream = createWriteStream(outputFilePath)
    console.log(`[WORKER ${threadId}] Created assistant audio log: ${outputFilePath}`)

    return outputAudioStream
  } catch (error) {
    console.error(`[WORKER ${threadId}] Failed to create audio log directory:`, error)
    return null
  }
}

// Handle encoded Opus packets
opusEncoder.on('data', (packet: Buffer) => {
  opusPacketQueue.push(packet)
})

// Handle errors
resampler.on('error', (error: any) => {
  console.error(`[WORKER ${threadId}] Resampler error:`, error)
  sendError(`Resampler error: ${error.message}`)
})

opusEncoder.on('error', (error: any) => {
  console.error(`[WORKER ${threadId}] Encoder error:`, error)
  sendError(`Encoder error: ${error.message}`)
})

function sendError(error: string) {
  parentPort!.postMessage({
    type: 'error',
    error,
  } satisfies WorkerOutMessage)
}

function cleanup() {
  stopPacketSending()
  if (session) {
    session.stop()
    session = null
  }
  if (audioLogStream) {
    audioLogStream.end()
    console.log(`[WORKER ${threadId}] Closed assistant audio log stream`)
    audioLogStream = null
  }
  resampler.end()
}

async function cleanupAsync(): Promise<void> {
  console.log(`[WORKER ${threadId}] Starting async cleanup`)

  stopPacketSending()

  if (session) {
    console.log(`[WORKER ${threadId}] Stopping GenAI session`)
    session.stop()
    session = null
  }

  // Wait for audio log stream to finish writing
  if (audioLogStream) {
    console.log(`[WORKER ${threadId}] Closing assistant audio log stream`)
    await new Promise<void>((resolve, reject) => {
      audioLogStream!.end(() => {
        console.log(`[WORKER ${threadId}] Assistant audio log stream closed`)
        resolve()
      })
      audioLogStream!.on('error', reject)
      // Add timeout to prevent hanging
      setTimeout(() => {
        console.log(`[WORKER ${threadId}] Audio stream close timeout, continuing`)
        resolve()
      }, 3000)
    })
    audioLogStream = null
  }

  // Unpipe and end the encoder first
  resampler.unpipe(opusEncoder)

  // End the encoder stream
  await new Promise<void>((resolve) => {
    opusEncoder.end(() => {
      console.log(`[WORKER ${threadId}] Opus encoder ended`)
      resolve()
    })
    // Add timeout
    setTimeout(resolve, 1000)
  })

  // End the resampler stream
  await new Promise<void>((resolve) => {
    resampler.end(() => {
      console.log(`[WORKER ${threadId}] Resampler ended`)
      resolve()
    })
    // Add timeout
    setTimeout(resolve, 1000)
  })

  console.log(`[WORKER ${threadId}] Async cleanup complete`)
}

// Handle messages from main thread
parentPort.on('message', async (message: WorkerInMessage) => {
  try {
    switch (message.type) {
      case 'init': {
        console.log(`[WORKER ${threadId}] Initializing with directory:`, message.directory)

        // Create audio log stream for assistant audio
        audioLogStream = await createAssistantAudioLogStream(message.guildId, message.channelId)

        // Start packet sending interval
        startPacketSending()

        // Get tools for the directory
        const { tools } = await getTools({
          directory: message.directory,
          onMessageCompleted: (params) => {
            parentPort!.postMessage({
              type: 'toolCallCompleted',
              ...params,
            } satisfies WorkerOutMessage)
          },
        })

        // Start GenAI session
        session = await startGenAiSession({
          tools,
          systemMessage: message.systemMessage,
          onAssistantAudioChunk({ data }) {
            // Write to audio log if enabled
            audioLogStream?.write(data)

            // Write PCM data to resampler which will output Opus packets
            resampler.write(data)
          },
          onAssistantStartSpeaking() {
            parentPort!.postMessage({
              type: 'assistantStartSpeaking',
            } satisfies WorkerOutMessage)
          },
          onAssistantStopSpeaking() {
            parentPort!.postMessage({
              type: 'assistantStopSpeaking',
            } satisfies WorkerOutMessage)
          },
          onAssistantInterruptSpeaking() {
            parentPort!.postMessage({
              type: 'assistantInterruptSpeaking',
            } satisfies WorkerOutMessage)
          },
        })

        // Notify main thread we're ready
        parentPort!.postMessage({
          type: 'ready',
        } satisfies WorkerOutMessage)
        break
      }

      case 'sendRealtimeInput': {
        if (!session) {
          sendError('Session not initialized')
          return
        }
        session.session.sendRealtimeInput({
          audio: message.audio,
        })
        break
      }

      case 'sendTextInput': {
        if (!session) {
          sendError('Session not initialized')
          return
        }
        session.session.sendRealtimeInput({
          text: message.text,
        })
        break
      }

      case 'interrupt': {
        console.log(`[WORKER ${threadId}] Interrupting playback`)
        // Clear the opus packet queue
        opusPacketQueue.length = 0
        break
      }

      case 'stop': {
        console.log(`[WORKER ${threadId}] Stopping worker`)
        await cleanupAsync()
        // process.exit(0)
        break
      }
    }
  } catch (error) {
    console.error(`[WORKER ${threadId}] Error handling message:`, error)
    sendError(
      error instanceof Error ? error.message : 'Unknown error in worker'
    )
  }
})
