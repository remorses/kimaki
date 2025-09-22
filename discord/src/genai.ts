import {
  GoogleGenAI,
  LiveServerMessage,
  MediaResolution,
  Modality,
  Session,
} from '@google/genai'
import { writeFile } from 'fs'

const audioParts: Buffer[] = []

function saveBinaryFile(fileName: string, content: Buffer) {
  writeFile(fileName, content, 'utf8', (err) => {
    if (err) {
      console.error(`Error writing file ${fileName}:`, err)
      return
    }
    console.log(`Appending stream content to file ${fileName}.`)
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

function defaultAudioChunkHandler({
  data,
  mimeType,
}: {
  data: Buffer
  mimeType: string
}) {
  audioParts.push(data)
  const fileName = 'audio.wav'
  const buffer = convertToWav(audioParts, mimeType)
  saveBinaryFile(fileName, buffer)
}

export async function startGenAiSession({
  onAssistantAudioChunk,
}: {
  onAssistantAudioChunk?: (args: { data: Buffer; mimeType: string }) => void
} = {}) {
  const responseQueue: LiveServerMessage[] = []
  let session: Session | undefined = undefined

  const audioChunkHandler = onAssistantAudioChunk || defaultAudioChunkHandler

  async function handleTurn(): Promise<LiveServerMessage[]> {
    const turn: LiveServerMessage[] = []
    let done = false
    while (!done) {
      const message = await waitMessage()
      turn.push(message)
      if (message.serverContent && message.serverContent.turnComplete) {
        done = true
      }
    }
    return turn
  }

  async function startListening() {
    while (session) {
      try {
        await handleTurn()
      } catch (error) {
        console.error('Error handling turn:', error)
      }
    }
  }

  async function waitMessage(): Promise<LiveServerMessage> {
    let done = false
    let message: LiveServerMessage | undefined = undefined
    while (!done) {
      message = responseQueue.shift()
      if (message) {
        handleModelTurn(message)
        done = true
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    return message!
  }

  function handleModelTurn(message: LiveServerMessage) {
    if (message.serverContent?.modelTurn?.parts) {
      const part = message.serverContent?.modelTurn?.parts?.[0]

      if (part?.fileData) {
        console.log(`File: ${part?.fileData.fileUri}`)
      }

      if (part?.inlineData) {
        const inlineData = part?.inlineData
        const buffer = Buffer.from(inlineData?.data ?? '', 'base64')
        audioChunkHandler({
          data: buffer,
          mimeType: inlineData.mimeType ?? '',
        })
      }

      if (part?.text) {
        console.log(part?.text)
      }
    }
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  })

  const model = 'models/gemini-2.5-flash-live-preview'

  const config = {
    responseModalities: [Modality.AUDIO],
    mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    speechConfig: {
      languageCode: 'en-US',
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: 'Puck',
        },
      },
    },
    contextWindowCompression: {
      triggerTokens: '25600',
      slidingWindow: { targetTokens: '12800' },
    },
  }

  session = await ai.live.connect({
    model,
    callbacks: {
      onopen: function () {
        console.debug('Opened')
      },
      onmessage: function (message: LiveServerMessage) {
        responseQueue.push(message)
      },
      onerror: function (e: ErrorEvent) {
        console.debug('Error:', e.message)
      },
      onclose: function (e: CloseEvent) {
        console.debug('Close:', e.reason)
      },
    },
    config,
  })

  startListening()

  return {
    session,
    stop: () => {
      const currentSession = session
      session = undefined
      currentSession?.close()
    },
  }
}
