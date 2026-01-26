// Google GenAI Live session manager for real-time voice interactions.
// Establishes bidirectional audio streaming with Gemini, handles tool calls,
// and manages the assistant's audio output for Discord voice channels.

import { GoogleGenAI, LiveServerMessage, MediaResolution, Modality, Session } from '@google/genai'
import type { CallableTool } from '@google/genai'
import { writeFile } from 'fs'
import type { Tool as AITool } from 'ai'

import { createLogger, LogPrefix } from './logger.js'
import { aiToolToCallableTool } from './ai-tool-to-genai.js'

const genaiLogger = createLogger(LogPrefix.GENAI)

const audioParts: Buffer[] = []

function saveBinaryFile(fileName: string, content: Buffer) {
  writeFile(fileName, content, 'utf8', (err) => {
    if (err) {
      genaiLogger.error(`Error writing file ${fileName}:`, err)
      return
    }
    genaiLogger.log(`Appending stream content to file ${fileName}.`)
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

export async function startGenAiSession({
  onAssistantAudioChunk,
  onAssistantStartSpeaking,
  onAssistantStopSpeaking,
  onAssistantInterruptSpeaking,
  systemMessage,
  tools,
  geminiApiKey,
}: {
  onAssistantAudioChunk?: (args: { data: Buffer; mimeType: string }) => void
  onAssistantStartSpeaking?: () => void
  onAssistantStopSpeaking?: () => void
  onAssistantInterruptSpeaking?: () => void
  systemMessage?: string
  tools?: Record<string, AITool<any, any>>
  geminiApiKey?: string | null
} = {}) {
  let session: Session | undefined = undefined
  const callableTools: Array<CallableTool & { name: string }> = []
  let isAssistantSpeaking = false

  const audioChunkHandler = onAssistantAudioChunk || defaultAudioChunkHandler

  // Convert AI SDK tools to GenAI CallableTools
  if (tools) {
    for (const [name, tool] of Object.entries(tools)) {
      callableTools.push(aiToolToCallableTool(tool, name))
    }
  }

  function handleModelTurn(message: LiveServerMessage) {
    if (message.toolCall) {
      genaiLogger.log('Tool call:', message.toolCall)

      // Handle tool calls
      if (message.toolCall.functionCalls && callableTools.length > 0) {
        for (const tool of callableTools) {
          if (!message.toolCall.functionCalls.some((x) => x.name === tool.name)) {
            continue
          }
          tool
            .callTool(message.toolCall.functionCalls)
            .then((parts) => {
              const functionResponses = parts
                .filter((part) => part.functionResponse)
                .map((part) => ({
                  response: part.functionResponse!.response as Record<string, unknown>,
                  id: part.functionResponse!.id,
                  name: part.functionResponse!.name,
                }))

              if (functionResponses.length > 0 && session) {
                session.sendToolResponse({ functionResponses })
                genaiLogger.log('client-toolResponse: ' + JSON.stringify({ functionResponses }))
              }
            })
            .catch((error) => {
              genaiLogger.error('Error handling tool calls:', error)
            })
        }
      }
    }
    if (message.serverContent?.modelTurn?.parts) {
      for (const part of message.serverContent.modelTurn.parts) {
        if (part?.fileData) {
          genaiLogger.log(`File: ${part?.fileData.fileUri}`)
        }

        if (part?.inlineData) {
          const inlineData = part.inlineData
          if (!inlineData.mimeType || !inlineData.mimeType.startsWith('audio/')) {
            genaiLogger.log('Skipping non-audio inlineData:', inlineData.mimeType)
            continue
          }

          // Trigger start speaking callback the first time audio is received
          if (!isAssistantSpeaking && onAssistantStartSpeaking) {
            isAssistantSpeaking = true
            onAssistantStartSpeaking()
          }

          const buffer = Buffer.from(inlineData?.data ?? '', 'base64')
          audioChunkHandler({
            data: buffer,
            mimeType: inlineData.mimeType ?? '',
          })
        }

        if (part?.text) {
          genaiLogger.log('Text:', part.text)
        }
      }
    }
    // Handle input transcription (user's audio transcription)
    if (message.serverContent?.inputTranscription?.text) {
      genaiLogger.log('[user transcription]', message.serverContent.inputTranscription.text)
    }

    // Handle output transcription (model's audio transcription)
    if (message.serverContent?.outputTranscription?.text) {
      genaiLogger.log('[assistant transcription]', message.serverContent.outputTranscription.text)
    }
    if (message.serverContent?.interrupted) {
      genaiLogger.log('Assistant was interrupted')
      if (isAssistantSpeaking && onAssistantInterruptSpeaking) {
        isAssistantSpeaking = false
        onAssistantInterruptSpeaking()
      }
    }
    if (message.serverContent?.turnComplete) {
      genaiLogger.log('Assistant turn complete')
      if (isAssistantSpeaking && onAssistantStopSpeaking) {
        isAssistantSpeaking = false
        onAssistantStopSpeaking()
      }
    }
  }

  const apiKey = geminiApiKey || process.env.GEMINI_API_KEY

  if (!apiKey) {
    genaiLogger.error('No Gemini API key provided')
    throw new Error('Gemini API key is required for voice interactions')
  }

  const ai = new GoogleGenAI({
    apiKey,
  })

  const model = 'gemini-2.5-flash-native-audio-preview-12-2025'

  session = await ai.live.connect({
    model,
    callbacks: {
      onopen: function () {
        genaiLogger.debug('Opened')
      },
      onmessage: function (message: LiveServerMessage) {
        // genaiLogger.log(message)
        try {
          handleModelTurn(message)
        } catch (error) {
          genaiLogger.error('Error handling turn:', error)
        }
      },
      onerror: function (e: ErrorEvent) {
        genaiLogger.debug('Error:', e.message)
      },
      onclose: function (e: CloseEvent) {
        genaiLogger.debug('Close:', e.reason)
      },
    },
    config: {
      tools: callableTools,
      responseModalities: [Modality.AUDIO],
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      inputAudioTranscription: {}, // transcribes your input speech
      outputAudioTranscription: {}, // transcribes the model's spoken audio
      systemInstruction: {
        parts: [
          {
            text: systemMessage || '',
          },
        ],
      },
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: 'Charon', // Orus also not bad
          },
        },
      },
      contextWindowCompression: {
        triggerTokens: '25600',

        slidingWindow: { targetTokens: '12800' },
      },
    },
  })

  return {
    session,
    stop: () => {
      const currentSession = session
      session = undefined
      currentSession?.close()
    },
  }
}
