/* eslint-disable @typescript-eslint/ban-ts-comment */
/* istanbul ignore file */
// @ts-nocheck

import { RealtimeClient } from '@openai/realtime-api-beta'
import { writeFile } from 'fs'
import type { Tool } from 'ai'
import { createLogger } from './logger.js'

const openaiLogger = createLogger('OPENAI')

// Export the session type for reuse
export interface OpenAIRealtimeSession {
  send: (audioData: ArrayBuffer) => void
  sendText: (text: string) => void
  close: () => void
}

// Type definitions based on @openai/realtime-api-beta
interface ConversationItem {
  id: string
  object: string
  type: 'message' | 'function_call' | 'function_call_output'
  status: 'in_progress' | 'completed' | 'incomplete'
  role?: 'user' | 'assistant' | 'system'
  content?: Array<{
    type: string
    text?: string
    audio?: string
    transcript?: string | null
  }>
  formatted: {
    audio?: Int16Array
    text?: string
    transcript?: string
    tool?: {
      type: 'function'
      name: string
      call_id: string
      arguments: string
    }
    output?: string
  }
}

interface ConversationEventDelta {
  audio?: Int16Array
  text?: string
  transcript?: string
  arguments?: string
}

const audioParts: Buffer[] = []

function saveBinaryFile(fileName: string, content: Buffer) {
  writeFile(fileName, content, 'utf8', (err) => {
    if (err) {
      openaiLogger.error(`Error writing file ${fileName}:`, err)
      return
    }
    openaiLogger.log(`Appending stream content to file ${fileName}.`)
  })
}

interface WavConversionOptions {
  numChannels: number
  sampleRate: number
  bitsPerSample: number
}

function convertToWav(rawData: Buffer[], mimeType: string) {
  const options = parseMimeType(mimeType)
  const dataLength = rawData.reduce((a, b) => a + b.length, 0)
  const wavHeader = createWavHeader(dataLength, options)
  const buffer = Buffer.concat(rawData)

  return Buffer.concat([wavHeader, buffer])
}

function parseMimeType(mimeType: string) {
  const [fileType, ...params] = mimeType.split(';').map((s) => s.trim())
  const [_, format] = fileType?.split('/') || []

  const options: Partial<WavConversionOptions> = {
    numChannels: 1,
    bitsPerSample: 16,
  }

  if (format && format.startsWith('L')) {
    const bits = parseInt(format.slice(1), 10)
    if (!isNaN(bits)) {
      options.bitsPerSample = bits
    }
  }

  for (const param of params) {
    const [key, value] = param.split('=').map((s) => s.trim())
    if (key === 'rate') {
      options.sampleRate = parseInt(value || '', 10)
    }
  }

  return options as WavConversionOptions
}

function createWavHeader(dataLength: number, options: WavConversionOptions) {
  const { numChannels, sampleRate, bitsPerSample } = options

  // http://soundfile.sapp.org/doc/WaveFormat

  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const buffer = Buffer.alloc(44)

  buffer.write('RIFF', 0) // ChunkID
  buffer.writeUInt32LE(36 + dataLength, 4) // ChunkSize
  buffer.write('WAVE', 8) // Format
  buffer.write('fmt ', 12) // Subchunk1ID
  buffer.writeUInt32LE(16, 16) // Subchunk1Size (PCM)
  buffer.writeUInt16LE(1, 20) // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22) // NumChannels
  buffer.writeUInt32LE(sampleRate, 24) // SampleRate
  buffer.writeUInt32LE(byteRate, 28) // ByteRate
  buffer.writeUInt16LE(blockAlign, 32) // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, 34) // BitsPerSample
  buffer.write('data', 36) // Subchunk2ID
  buffer.writeUInt32LE(dataLength, 40) // Subchunk2Size

  return buffer
}

function defaultAudioChunkHandler({ data, mimeType }: { data: Buffer; mimeType: string }) {
  audioParts.push(data)
  const fileName = 'audio.wav'
  const buffer = convertToWav(audioParts, mimeType)
  saveBinaryFile(fileName, buffer)
}

export interface GenAISessionResult {
  session: OpenAIRealtimeSession
  stop: () => void
}

export async function startGenAiSession({
  onAssistantAudioChunk,
  onAssistantStartSpeaking,
  onAssistantStopSpeaking,
  onAssistantInterruptSpeaking,
  systemMessage,
  tools,
}: {
  onAssistantAudioChunk?: (args: { data: Buffer; mimeType: string }) => void
  onAssistantStartSpeaking?: () => void
  onAssistantStopSpeaking?: () => void
  onAssistantInterruptSpeaking?: () => void
  systemMessage?: string
  // Accept tools but use structural typing to avoid variance issues
  tools?: Record<
    string,
    {
      description?: string
      inputSchema?: unknown
      execute?: Function
    }
  >
} = {}): Promise<GenAISessionResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable is required')
  }

  const client = new RealtimeClient({
    apiKey: process.env.OPENAI_API_KEY,
  })

  const audioChunkHandler = onAssistantAudioChunk || defaultAudioChunkHandler
  let isAssistantSpeaking = false

  // Configure session with 24kHz sample rate
  client.updateSession({
    instructions: systemMessage || '',
    voice: 'alloy',
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    input_audio_transcription: { model: 'whisper-1' },
    turn_detection: { type: 'server_vad' },
    modalities: ['text', 'audio'],
    temperature: 0.8,
  })

  // Add tools if provided
  if (tools) {
    for (const [name, tool] of Object.entries(tools)) {
      // Convert AI SDK tool to OpenAI Realtime format
      // The tool.inputSchema is a Zod schema, we need to convert it to JSON Schema
      let parameters: Record<string, unknown> = {
        type: 'object',
        properties: {},
        required: [],
      }

      // If the tool has a Zod schema, we can try to extract basic structure
      // For now, we'll use a simple placeholder
      if (tool.description?.includes('session')) {
        parameters = {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'The session ID' },
            message: { type: 'string', description: 'The message text' },
          },
          required: ['sessionId'],
        }
      }

      client.addTool(
        {
          type: 'function',
          name,
          description: tool.description || '',
          parameters,
        },
        async (params: Record<string, unknown>) => {
          try {
            if (!tool.execute || typeof tool.execute !== 'function') {
              return { error: 'Tool execute function not found' }
            }
            // Call the execute function with params
            // The Tool type from 'ai' expects (input, options) but we need to handle this safely
            const result = await tool.execute(params, {
              abortSignal: new AbortController().signal,
              toolCallId: '',
              messages: [],
            })
            return result
          } catch (error) {
            openaiLogger.error(`Tool ${name} execution error:`, error)
            return { error: String(error) }
          }
        },
      )
    }
  }

  // Set up event handlers
  client.on('conversation.item.created', ({ item }: { item: ConversationItem }) => {
    if ('role' in item && item.role === 'assistant' && item.type === 'message') {
      // Check if this is the first audio content
      const hasAudio =
        'content' in item &&
        Array.isArray(item.content) &&
        item.content.some((c) => 'type' in c && c.type === 'audio')
      if (hasAudio && !isAssistantSpeaking && onAssistantStartSpeaking) {
        isAssistantSpeaking = true
        onAssistantStartSpeaking()
      }
    }
  })

  client.on(
    'conversation.updated',
    ({ item, delta }: { item: ConversationItem; delta: ConversationEventDelta | null }) => {
      // Handle audio chunks
      if (delta?.audio && 'role' in item && item.role === 'assistant') {
        if (!isAssistantSpeaking && onAssistantStartSpeaking) {
          isAssistantSpeaking = true
          onAssistantStartSpeaking()
        }

        // OpenAI provides audio as Int16Array or base64
        let audioBuffer: Buffer
        if (delta.audio instanceof Int16Array) {
          audioBuffer = Buffer.from(delta.audio.buffer)
        } else {
          // Assume base64 string
          audioBuffer = Buffer.from(delta.audio, 'base64')
        }

        // OpenAI uses 24kHz PCM16 format
        audioChunkHandler({
          data: audioBuffer,
          mimeType: 'audio/pcm;rate=24000',
        })
      }

      // Handle transcriptions
      if (delta?.transcript) {
        if ('role' in item) {
          if (item.role === 'user') {
            openaiLogger.log('User transcription:', delta.transcript)
          } else if (item.role === 'assistant') {
            openaiLogger.log('Assistant transcription:', delta.transcript)
          }
        }
      }
    },
  )

  client.on('conversation.item.completed', ({ item }: { item: ConversationItem }) => {
    if (
      'role' in item &&
      item.role === 'assistant' &&
      isAssistantSpeaking &&
      onAssistantStopSpeaking
    ) {
      isAssistantSpeaking = false
      onAssistantStopSpeaking()
    }
  })

  client.on('conversation.interrupted', () => {
    openaiLogger.log('Assistant was interrupted')
    if (isAssistantSpeaking && onAssistantInterruptSpeaking) {
      isAssistantSpeaking = false
      onAssistantInterruptSpeaking()
    }
  })

  // Connect to the Realtime API
  await client.connect()

  const sessionResult: GenAISessionResult = {
    session: {
      send: (audioData: ArrayBuffer) => {
        // Convert ArrayBuffer to Int16Array for OpenAI
        const int16Data = new Int16Array(audioData)
        client.appendInputAudio(int16Data)
      },
      sendText: (text: string) => {
        // Send text message to OpenAI
        client.sendUserMessageContent([{ type: 'input_text', text }])
      },
      close: () => {
        client.disconnect()
      },
    },
    stop: () => {
      client.disconnect()
    },
  }

  return sessionResult
}
