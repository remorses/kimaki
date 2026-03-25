// Discord voice channel connection and audio stream handler.
// Manages joining/leaving voice channels, captures user audio, resamples to 16kHz,
// and routes audio to the GenAI worker for real-time voice assistant interactions.
import * as errore from 'errore'

import {
  VoiceConnectionStatus,
  EndBehaviorType,
  joinVoiceChannel,
  entersState,
  type VoiceConnection,
} from '@discordjs/voice'
import { exec } from 'node:child_process'
import fs, { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { Transform, type TransformCallback } from 'node:stream'
import * as prism from 'prism-media'
import dedent from 'string-dedent'
import {
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type Message,
  type ThreadChannel,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js'
import { createGenAIWorker, type GenAIWorker } from './genai-worker-wrapper.js'
import {
  getVoiceChannelDirectory,
  getGeminiApiKey,
  getTranscriptionApiKey,
  findTextChannelByVoiceChannel,
} from './database.js'
import {
  sendThreadMessage,
  escapeDiscordFormatting,
  SILENT_MESSAGE_FLAGS,
  hasKimakiBotPermission,
} from './discord-utils.js'
import {
  transcribeAudio,
  type TranscriptionResult,
  transcribeWithVLLM,
  checkVLLMService,
} from './voice.js'
import { startVLLMService, shouldAutoStartVLLM } from './vllm-service-manager.js'
import {
  startAsrService,
  shouldAutoStartAsr,
  isAppleSilicon,
} from './asr-service-manager.js'
import { FetchError } from './errors.js'
import { store } from './store.js'

import { createLogger, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'

const voiceLogger = createLogger(LogPrefix.VOICE)

export type VoiceConnectionData = {
  connection: VoiceConnection
  genAiWorker?: GenAIWorker
  userAudioStream?: fs.WriteStream
}

export const voiceConnections = new Map<string, VoiceConnectionData>()



export function convertToMono16k(buffer: Buffer): Buffer {
  const inputSampleRate = 48000
  const outputSampleRate = 16000
  const ratio = inputSampleRate / outputSampleRate
  const inputChannels = 2
  const bytesPerSample = 2

  const inputSamples = buffer.length / (bytesPerSample * inputChannels)
  const outputSamples = Math.floor(inputSamples / ratio)
  const outputBuffer = Buffer.alloc(outputSamples * bytesPerSample)

  for (let i = 0; i < outputSamples; i++) {
    const inputIndex = Math.floor(i * ratio) * inputChannels * bytesPerSample

    if (inputIndex + 3 < buffer.length) {
      const leftSample = buffer.readInt16LE(inputIndex)
      const rightSample = buffer.readInt16LE(inputIndex + 2)
      const monoSample = Math.round((leftSample + rightSample) / 2)

      outputBuffer.writeInt16LE(monoSample, i * bytesPerSample)
    }
  }

  return outputBuffer
}

export async function createUserAudioLogStream(
  guildId: string,
  channelId: string,
): Promise<fs.WriteStream | undefined> {
  if (!process.env.DEBUG) return undefined

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const audioDir = path.join(
    process.cwd(),
    'discord-audio-logs',
    guildId,
    channelId,
  )

  try {
    await mkdir(audioDir, { recursive: true })

    const inputFileName = `user_${timestamp}.16.pcm`
    const inputFilePath = path.join(audioDir, inputFileName)
    const inputAudioStream = createWriteStream(inputFilePath)
    voiceLogger.log(`Created user audio log: ${inputFilePath}`)

    return inputAudioStream
  } catch (error) {
    voiceLogger.error('Failed to create audio log directory:', error)
    return undefined
  }
}

export function frameMono16khz(): Transform {
  const FRAME_BYTES = (100 * 16_000 * 1 * 2) / 1000
  let stash: Buffer = Buffer.alloc(0)
  let offset = 0

  return new Transform({
    readableObjectMode: false,
    writableObjectMode: false,

    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      if (offset > 0) {
        stash = stash.subarray(offset)
        offset = 0
      }

      stash = stash.length ? Buffer.concat([stash, chunk]) : chunk

      while (stash.length - offset >= FRAME_BYTES) {
        this.push(stash.subarray(offset, offset + FRAME_BYTES))
        offset += FRAME_BYTES
      }

      if (offset === stash.length) {
        stash = Buffer.alloc(0)
        offset = 0
      }

      cb()
    },

    flush(cb: TransformCallback) {
      stash = Buffer.alloc(0)
      offset = 0
      cb()
    },
  })
}

export async function setupVoiceHandling({
  connection,
  guildId,
  channelId,
  appId,
  discordClient,
}: {
  connection: VoiceConnection
  guildId: string
  channelId: string
  appId: string
  discordClient: Client
}) {
  voiceLogger.log(
    `Setting up voice handling for guild ${guildId}, channel ${channelId}`,
  )

  const directory = await getVoiceChannelDirectory(channelId)

  if (!directory) {
    voiceLogger.log(
      `Voice channel ${channelId} has no associated directory, skipping setup`,
    )
    return
  }

  voiceLogger.log(`Found directory for voice channel: ${directory}`)

  const voiceData = voiceConnections.get(guildId)
  if (!voiceData) {
    voiceLogger.error(`No voice data found for guild ${guildId}`)
    return
  }

  voiceData.userAudioStream = await createUserAudioLogStream(guildId, channelId)

  const geminiApiKey = await getGeminiApiKey(appId)

  const genAiWorker = await createGenAIWorker({
    directory,
    guildId,
    channelId,
    appId,
    geminiApiKey,
    systemMessage: dedent`
    You are Kimaki, an AI similar to Jarvis: you help your user (an engineer) controlling his coding agent, just like Jarvis controls Ironman armor and machines. Speak fast.

    You should talk like Jarvis, British accent, satirical, joking and calm. Be short and concise. Speak fast.

    After tool calls give a super short summary of the assistant message, you should say what the assistant message writes.

    Before starting a new session ask for confirmation if it is not clear if the user finished describing it. ask "message ready, send?"

    NEVER repeat the whole tool call parameters or message.

    Your job is to manage many opencode agent chat instances. Opencode is the agent used to write the code, it is similar to Claude Code.

    For everything the user asks it is implicit that the user is asking for you to proxy the requests to opencode sessions.

    You can
    - start new chats on a given project
    - read the chats to report progress to the user
    - submit messages to the chat
    - list files for a given projects, so you can translate imprecise user prompts to precise messages that mention filename paths using @

    Common patterns
    - to get the last session use the listChats tool
    - when user asks you to do something you submit a new session to do it. it's implicit that you proxy requests to the agents chat!
    - when you submit a session assume the session will take a minute or 2 to complete the task

    Rules
    - never spell files by mentioning dots, letters, etc. instead give a brief description of the filename
    - NEVER spell hashes or IDs
    - never read session ids or other ids

    Your voice is calm and monotone, NEVER excited and goofy. But you speak without jargon or bs and do veiled short jokes.
    You speak like you knew something other don't. You are cool and cold.
    `,
    onAssistantOpusPacket(packet) {
      if (connection.state.status !== VoiceConnectionStatus.Ready) {
        voiceLogger.log('Skipping packet: connection not ready')
        return
      }

      try {
        connection.setSpeaking(true)
        connection.playOpusPacket(Buffer.from(packet))
      } catch (error) {
        voiceLogger.error('Error sending packet:', error)
      }
    },
    onAssistantStartSpeaking() {
      voiceLogger.log('Assistant started speaking')
      connection.setSpeaking(true)
    },
    onAssistantStopSpeaking() {
      voiceLogger.log('Assistant stopped speaking (natural finish)')
      connection.setSpeaking(false)
    },
    onAssistantInterruptSpeaking() {
      voiceLogger.log('Assistant interrupted while speaking')
      genAiWorker.interrupt()
      connection.setSpeaking(false)
    },
    onToolCallCompleted(params) {
      const errorText: string | undefined = (() => {
        if (!params.error) {
          return undefined
        }
        if (params.error instanceof Error) {
          return params.error.message
        }
        return String(params.error)
      })()

      const text = params.error
        ? `<systemMessage>\nThe coding agent encountered an error while processing session ${params.sessionId}: ${errorText || 'Unknown error'}\n</systemMessage>`
        : `<systemMessage>\nThe coding agent finished working on session ${params.sessionId}\n\nHere's what the assistant wrote:\n${params.markdown}\n</systemMessage>`

      genAiWorker.sendTextInput(text)
    },
    async onError(error) {
      voiceLogger.error('GenAI worker error:', error)
      const textChannelId = await findTextChannelByVoiceChannel(channelId)

      if (textChannelId) {
        try {
          const textChannel = await discordClient.channels.fetch(textChannelId)
          if (textChannel?.isTextBased() && 'send' in textChannel) {
            await textChannel.send({
              content: `⚠️ Voice session error: ${String(error).slice(0, 1900)}`,
              flags: SILENT_MESSAGE_FLAGS,
            })
          }
        } catch (e) {
          voiceLogger.error('Failed to send error to text channel:', e)
        }
      }
    },
  })

  if (voiceData.genAiWorker) {
    voiceLogger.log('Stopping existing GenAI worker before creating new one')
    await voiceData.genAiWorker.stop()
  }

  genAiWorker.sendTextInput(
    `<systemMessage>\nsay "Hello boss, how we doing today?"\n</systemMessage>`,
  )

  voiceData.genAiWorker = genAiWorker

  const receiver = connection.receiver

  receiver.speaking.removeAllListeners('start')

  let speakingSessionCount = 0

  receiver.speaking.on('start', (userId) => {
    voiceLogger.log(`User ${userId} started speaking`)

    speakingSessionCount++
    const currentSessionCount = speakingSessionCount
    voiceLogger.log(`Speaking session ${currentSessionCount} started`)

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
    })

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    })

    decoder.on('error', (error) => {
      voiceLogger.error(`Opus decoder error for user ${userId}:`, error)
      void notifyError(error, `Opus decoder error for user ${userId}`)
    })

    const downsampleTransform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          const downsampled = convertToMono16k(chunk)
          callback(null, downsampled)
        } catch (error) {
          callback(error as Error)
        }
      },
    })

    const framer = frameMono16khz()

    const pipeline = audioStream
      .pipe(decoder)
      .pipe(downsampleTransform)
      .pipe(framer)

    pipeline
      .on('data', (frame: Buffer) => {
        if (currentSessionCount !== speakingSessionCount) {
          return
        }

        if (!voiceData.genAiWorker) {
          voiceLogger.warn(
            `[VOICE] Received audio frame but no GenAI worker active for guild ${guildId}`,
          )
          return
        }

        voiceData.userAudioStream?.write(frame)

        voiceData.genAiWorker.sendRealtimeInput({
          audio: {
            mimeType: 'audio/pcm;rate=16000',
            data: frame.toString('base64'),
          },
        })
      })
      .on('end', () => {
        if (currentSessionCount === speakingSessionCount) {
          voiceLogger.log(
            `User ${userId} stopped speaking (session ${currentSessionCount})`,
          )
          voiceData.genAiWorker?.sendRealtimeInput({
            audioStreamEnd: true,
          })
        } else {
          voiceLogger.log(
            `User ${userId} stopped speaking (session ${currentSessionCount}), but skipping audioStreamEnd because newer session ${speakingSessionCount} exists`,
          )
        }
      })
      .on('error', (error) => {
        voiceLogger.error(`Pipeline error for user ${userId}:`, error)
        void notifyError(error, `Voice pipeline error for user ${userId}`)
      })

    audioStream.on('error', (error) => {
      voiceLogger.error(`Audio stream error for user ${userId}:`, error)
      void notifyError(error, `Audio stream error for user ${userId}`)
    })

    downsampleTransform.on('error', (error) => {
      voiceLogger.error(`Downsample transform error for user ${userId}:`, error)
      void notifyError(error, `Downsample transform error for user ${userId}`)
    })

    framer.on('error', (error) => {
      voiceLogger.error(`Framer error for user ${userId}:`, error)
      void notifyError(error, `Framer error for user ${userId}`)
    })
  })
}

export async function cleanupVoiceConnection(guildId: string) {
  const voiceData = voiceConnections.get(guildId)
  if (!voiceData) return

  voiceLogger.log(`Starting cleanup for guild ${guildId}`)

  try {
    if (voiceData.genAiWorker) {
      voiceLogger.log(`Stopping GenAI worker...`)
      await voiceData.genAiWorker.stop()
      voiceLogger.log(`GenAI worker stopped`)
    }

    if (voiceData.userAudioStream) {
      voiceLogger.log(`Closing user audio stream...`)
      await new Promise<void>((resolve) => {
        voiceData.userAudioStream!.end(() => {
          voiceLogger.log('User audio stream closed')
          resolve()
        })
        setTimeout(resolve, 2000)
      })
    }

    if (voiceData.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      voiceLogger.log(`Destroying voice connection...`)
      voiceData.connection.destroy()
    }

    voiceConnections.delete(guildId)
    voiceLogger.log(`Cleanup complete for guild ${guildId}`)
  } catch (error) {
    voiceLogger.error(`Error during cleanup for guild ${guildId}:`, error)
    voiceConnections.delete(guildId)
  }
}

type ProcessVoiceAttachmentArgs = {
  message: Message
  thread: ThreadChannel
  projectDirectory?: string
  isNewThread?: boolean
  appId?: string
  currentSessionContext?: string
  lastSessionContext?: string
}

// Per-thread serialization is handled by ThreadSessionRuntime.enqueueIncoming()
// via the runtime action queue; no local serialization is needed here.
export async function processVoiceAttachment({
  message,
  thread,
  projectDirectory,
  isNewThread = false,
  appId,
  currentSessionContext,
  lastSessionContext,
}: ProcessVoiceAttachmentArgs): Promise<TranscriptionResult | null> {
  const audioAttachment = Array.from(message.attachments.values()).find(
    (attachment) => attachment.contentType?.startsWith('audio/'),
  )

  if (!audioAttachment) return null

  voiceLogger.log(
    `Detected audio attachment: ${audioAttachment.name} (${audioAttachment.contentType})`,
  )

  await sendThreadMessage(thread, '🎤 Transcribing voice message...')

  // Deterministic mode: skip audio download and AI model call entirely,
  // return a canned result after an optional delay. Used by e2e tests to
  // control transcription output, timing, and queueMessage deterministically.
  // Only active when KIMAKI_VITEST=1 to prevent accidental activation in production.
  const deterministicConfig =
    process.env['KIMAKI_VITEST'] === '1'
      ? store.getState().test.deterministicTranscription
      : null
  if (deterministicConfig) {
    if (deterministicConfig.delayMs) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, deterministicConfig.delayMs)
      })
    }
    const result: TranscriptionResult = {
      transcription: deterministicConfig.transcription,
      queueMessage: deterministicConfig.queueMessage,
    }
    voiceLogger.log(
      `[DETERMINISTIC] Returning canned transcription: "${result.transcription}"${result.queueMessage ? ' [QUEUE]' : ''}`,
    )
    if (isNewThread) {
      const threadName = result.transcription.replace(/\s+/g, ' ').trim().slice(0, 80)
      if (threadName) {
        await errore.tryAsync({
          try: () => thread.setName(threadName),
          catch: (e) => e as Error,
        })
      }
    }
    await sendThreadMessage(
      thread,
      `📝 **Transcribed message:** ${escapeDiscordFormatting(result.transcription)}`,
    )
    return result
  }

  const audioResponse = await errore.tryAsync({
    try: () => fetch(audioAttachment.url),
    catch: (e) => new FetchError({ url: audioAttachment.url, cause: e }),
  })
  if (audioResponse instanceof Error) {
    voiceLogger.error(
      `Failed to download audio attachment:`,
      audioResponse.message,
    )
    await sendThreadMessage(
      thread,
      `⚠️ Failed to download audio: ${audioResponse.message}`,
    )
    return null
  }
  const audioBuffer = Buffer.from(await audioResponse.arrayBuffer())

  voiceLogger.log(`Downloaded ${audioBuffer.length} bytes, transcribing...`)

  let transcriptionPrompt = 'Discord voice message transcription'

  if (projectDirectory) {
    try {
      voiceLogger.log(`Getting project file tree from ${projectDirectory}`)
      const execAsync = promisify(exec)
      const { stdout } = await execAsync('git ls-files | tree --fromfile -a', {
        cwd: projectDirectory,
      })

      if (stdout) {
        transcriptionPrompt = `Discord voice message transcription. Project file structure:\n${stdout}\n\nPlease transcribe file names and paths accurately based on this context.`
        voiceLogger.log(`Added project context to transcription prompt`)
      }
    } catch (e) {
      voiceLogger.log(`Could not get project tree:`, e)
    }
  }

  // Determine ASR provider: parakeet is the default only on Apple Silicon (MLX requirement)
  const asrProvider = process.env.ASR_PROVIDER?.toLowerCase()
  const useCloudProvider = asrProvider === 'openai' || asrProvider === 'gemini'
  const useVLLMProvider = asrProvider === 'vllm'
  const useParakeetDefault = !useCloudProvider && !useVLLMProvider && isAppleSilicon()

  // Helper to get fallback providers for parakeet failure
  // Returns vLLM first (if available), then OpenAI/Gemini
  // Auto-starts vLLM if configured to do so
  async function getFallbackProviders(): Promise<
    Array<
      | { type: 'vllm' }
      | { type: 'cloud'; apiKey: string; provider: 'openai' | 'gemini' }
    >
  > {
    const providers: Array<
      | { type: 'vllm' }
      | { type: 'cloud'; apiKey: string; provider: 'openai' | 'gemini' }
    > = []

    // Check vLLM service first (local, no API key needed)
    let vllmAvailable = await checkVLLMService()
    
    // Auto-start vLLM if configured and not running
    if (!vllmAvailable && shouldAutoStartVLLM()) {
      voiceLogger.log('Auto-starting vLLM service (VLLM_AUTO_START=true or ASR_PROVIDER=vllm)')
      vllmAvailable = await startVLLMService()
    }
    
    if (vllmAvailable) {
      providers.push({ type: 'vllm' })
    }

    // Check app-level stored API key
    if (appId) {
      const stored = await getTranscriptionApiKey(appId)
      if (stored) {
        providers.push({ type: 'cloud', apiKey: stored.apiKey, provider: stored.provider as 'openai' | 'gemini' })
      }
    }

    // Check environment variables
    if (process.env.OPENAI_API_KEY) {
      providers.push({ type: 'cloud', apiKey: process.env.OPENAI_API_KEY, provider: 'openai' })
    }
    if (process.env.GEMINI_API_KEY) {
      providers.push({ type: 'cloud', apiKey: process.env.GEMINI_API_KEY, provider: 'gemini' })
    }

    return providers
  }

  // Handle vLLM direct transcription (ASR_PROVIDER=vllm)
  if (useVLLMProvider) {
    voiceLogger.log('Using vLLM transcription (ASR_PROVIDER=vllm)')
    
    // Auto-start vLLM if configured
    let vllmAvailable = await checkVLLMService()
    if (!vllmAvailable && shouldAutoStartVLLM()) {
      voiceLogger.log('Auto-starting vLLM service...')
      vllmAvailable = await startVLLMService()
    }
    
    if (!vllmAvailable) {
      await sendThreadMessage(
        thread,
        '⚠️ vLLM service is not running. Install vLLM: `pip install vllm[audio]` then run: `vllm serve openai/whisper-large-v3-turbo --port 8766`. Or set `VLLM_AUTO_START=true`.',
      )
      return null
    }
    
    const transcription = await transcribeWithVLLM({
      audioBuffer,
      mediaType: audioAttachment.contentType || 'audio/wav',
    })
    
    if (transcription instanceof Error) {
      const errMsg = transcription.message
      voiceLogger.error(`vLLM transcription failed:`, transcription)
      
      // Try fallback to other providers
      const fallbackProviders = await getFallbackProviders()
      // Filter out vLLM from fallback since it already failed
      const cloudProviders = fallbackProviders.filter((p): p is { type: 'cloud'; apiKey: string; provider: 'openai' | 'gemini' } => p.type === 'cloud')
      
      if (cloudProviders.length === 0) {
        await sendThreadMessage(
          thread,
          `⚠️ vLLM transcription failed (${errMsg}). No fallback API keys available. Set OPENAI_API_KEY or GEMINI_API_KEY.`,
        )
        return null
      }
      
      voiceLogger.log(`Trying fallback providers (${cloudProviders.length} available)`)
      await sendThreadMessage(
        thread,
        `⚠️ vLLM transcription failed (${errMsg}). Trying fallback provider...`,
      )
      
      for (const { apiKey, provider } of cloudProviders) {
        voiceLogger.log(`Trying fallback provider: ${provider}`)
        const fallbackTranscription = await transcribeAudio({
          audio: audioBuffer,
          prompt: transcriptionPrompt,
          apiKey,
          provider,
          mediaType: audioAttachment.contentType || undefined,
          currentSessionContext,
          lastSessionContext,
        })
        
        if (!(fallbackTranscription instanceof Error)) {
          voiceLogger.log(`Fallback to ${provider} succeeded`)
          await sendThreadMessage(
            thread,
            `📝 **Transcribed message:** ${escapeDiscordFormatting(fallbackTranscription.transcription)}`,
          )
          return fallbackTranscription
        }
        
        voiceLogger.warn(`Fallback to ${provider} failed:`, fallbackTranscription.message)
      }
      
      await sendThreadMessage(
        thread,
        `⚠️ All transcription providers failed. vLLM: ${errMsg}`,
      )
      return null
    }
    
    const { transcription: text, queueMessage } = transcription
    voiceLogger.log(
      `Transcription successful: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"${queueMessage ? ' [QUEUE]' : ''}`,
    )
    
    // ...rest of successful transcription handling
    return transcription
  }

  if (useParakeetDefault) {
    // Use parakeet (local ASR) - default on Apple Silicon when ASR_PROVIDER is not set
    if (asrProvider === 'parakeet') {
      voiceLogger.log('Using parakeet local ASR service (ASR_PROVIDER=parakeet)')
    } else {
      voiceLogger.log('Using parakeet local ASR service (default on Apple Silicon)')
    }
    const transcription = await transcribeAudio({
      audio: audioBuffer,
      prompt: transcriptionPrompt,
      provider: 'parakeet',
      mediaType: audioAttachment.contentType || undefined,
      currentSessionContext,
      lastSessionContext,
    })

    if (transcription instanceof Error) {
      const errMsg = errore.matchError(transcription, {
        TranscriptionError: (e) => e.message,
        InvalidAudioFormatError: (e) => e.message,
        ApiKeyMissingError: (e) => e.message,
        EmptyTranscriptionError: (e) => e.message,
        NoResponseContentError: (e) => e.message,
        NoToolResponseError: (e) => e.message,
        Error: (e) => e.message,
      })
      voiceLogger.error(`Parakeet transcription failed:`, transcription)

      // Try fallback to other providers
      const fallbackProviders = await getFallbackProviders()
      if (fallbackProviders.length === 0) {
        await sendThreadMessage(
          thread,
          `⚠️ Parakeet transcription failed (${errMsg}). No fallback providers available. Start vLLM service or set OPENAI_API_KEY or GEMINI_API_KEY.`,
        )
        return null
      }

      voiceLogger.log(`Trying fallback providers (${fallbackProviders.length} available)`)
      await sendThreadMessage(
        thread,
        `⚠️ Parakeet transcription failed (${errMsg}). Trying fallback provider...`,
      )

      for (const fallbackProvider of fallbackProviders) {
        // Handle vLLM (local) provider
        if (fallbackProvider.type === 'vllm') {
          voiceLogger.log('Trying fallback provider: vLLM (local)')
          const fallbackTranscription = await transcribeWithVLLM({
            audioBuffer,
            mediaType: audioAttachment.contentType || 'audio/wav',
          })

          if (!(fallbackTranscription instanceof Error)) {
            voiceLogger.log('Fallback to vLLM succeeded')
            await sendThreadMessage(
              thread,
              `📝 **Transcribed message:** ${escapeDiscordFormatting(fallbackTranscription.transcription)}`,
            )
            return fallbackTranscription
          }

          voiceLogger.warn('Fallback to vLLM failed:', fallbackTranscription.message)
          continue
        }

        // Handle cloud providers (OpenAI/Gemini)
        const { apiKey, provider } = fallbackProvider
        voiceLogger.log(`Trying fallback provider: ${provider}`)
        const fallbackTranscription = await transcribeAudio({
          audio: audioBuffer,
          prompt: transcriptionPrompt,
          apiKey,
          provider,
          mediaType: audioAttachment.contentType || undefined,
          currentSessionContext,
          lastSessionContext,
        })

        if (!(fallbackTranscription instanceof Error)) {
          voiceLogger.log(`Fallback to ${provider} succeeded`)
          await sendThreadMessage(
            thread,
            `📝 **Transcribed message:** ${escapeDiscordFormatting(fallbackTranscription.transcription)}`,
          )
          return fallbackTranscription
        }

        voiceLogger.warn(`Fallback to ${provider} failed:`, fallbackTranscription.message)
      }

      await sendThreadMessage(
        thread,
        `⚠️ All transcription providers failed. Parakeet: ${errMsg}`,
      )
      return null
    }

    const { transcription: text, queueMessage } = transcription
    voiceLogger.log(
      `Transcription successful: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"${queueMessage ? ' [QUEUE]' : ''}`,
    )

    if (isNewThread) {
      const threadName = text.replace(/\s+/g, ' ').trim().slice(0, 80)
      if (threadName) {
        const renamed = await Promise.race([
          errore.tryAsync({
            try: () => thread.setName(threadName),
            catch: (e) => e as Error,
          }),
          new Promise<null>((resolve) => {
            setTimeout(() => {
              resolve(null)
            }, 2000)
          }),
        ])
        if (renamed === null) {
          voiceLogger.log(`Thread name update timed out`)
        } else if (renamed instanceof Error) {
          voiceLogger.log(`Could not update thread name:`, renamed.message)
        } else {
          voiceLogger.log(`Updated thread name to: "${threadName}"`)
        }
      }
    }

    await sendThreadMessage(
      thread,
      `📝 **Transcribed message:** ${escapeDiscordFormatting(text)}`,
    )
    return transcription
  }

  // Not Apple Silicon: require cloud provider (OpenAI or Gemini)
  if (!useCloudProvider) {
    voiceLogger.warn('Parakeet MLX requires Apple Silicon. Please set ASR_PROVIDER to openai or gemini.')
    await sendThreadMessage(
      thread,
      '⚠️ Voice transcription requires a cloud provider on non-Apple Silicon devices. Set ASR_PROVIDER=openai or ASR_PROVIDER=gemini environment variable.',
    )
    return null
  }

  // Use cloud provider (OpenAI or Gemini) - only when ASR_PROVIDER is explicitly set to 'openai' or 'gemini'
  let transcriptionApiKey: string | undefined
  let transcriptionProvider: 'openai' | 'gemini' | undefined
  if (appId) {
    const stored = await getTranscriptionApiKey(appId)
    if (stored) {
      transcriptionApiKey = stored.apiKey
      transcriptionProvider = stored.provider
    }
  }
  if (!transcriptionApiKey) {
    if (process.env.OPENAI_API_KEY) {
      transcriptionApiKey = process.env.OPENAI_API_KEY
      transcriptionProvider = 'openai'
    } else if (process.env.GEMINI_API_KEY) {
      transcriptionApiKey = process.env.GEMINI_API_KEY
      transcriptionProvider = 'gemini'
    }
  }

  if (!transcriptionApiKey) {
    if (appId) {
      const button = new ButtonBuilder()
        .setCustomId(`transcription_apikey:${appId}`)
        .setLabel('Set Transcription API Key')
        .setStyle(ButtonStyle.Primary)

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button)

      await thread.send({
        content:
          'Voice transcription requires an API key (OpenAI or Gemini). Set one to enable voice message transcription.',
        components: [row],
        flags: SILENT_MESSAGE_FLAGS,
      })
    } else {
      await sendThreadMessage(
        thread,
        'Voice transcription requires an API key. Set OPENAI_API_KEY or GEMINI_API_KEY, or use /login in this channel.',
      )
    }
    return null
  }

  const transcription = await transcribeAudio({
    audio: audioBuffer,
    prompt: transcriptionPrompt,
    apiKey: transcriptionApiKey,
    provider: transcriptionProvider,
    mediaType: audioAttachment.contentType || undefined,
    currentSessionContext,
    lastSessionContext,
  })

  if (transcription instanceof Error) {
    const errMsg = errore.matchError(transcription, {
      ApiKeyMissingError: (e) => e.message,
      InvalidAudioFormatError: (e) => e.message,
      TranscriptionError: (e) => e.message,
      EmptyTranscriptionError: (e) => e.message,
      NoResponseContentError: (e) => e.message,
      NoToolResponseError: (e) => e.message,
      Error: (e) => e.message,
    })
    voiceLogger.error(`Transcription failed:`, transcription)
    await sendThreadMessage(thread, `⚠️ Transcription failed: ${errMsg}`)
    return null
  }

  const { transcription: text, queueMessage } = transcription

  voiceLogger.log(
    `Transcription successful: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"${queueMessage ? ' [QUEUE]' : ''}`,
  )

  if (isNewThread) {
    const threadName = text.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (threadName) {
      const renamed = await Promise.race([
        errore.tryAsync({
          try: () => thread.setName(threadName),
          catch: (e) => e as Error,
        }),
        new Promise<null>((resolve) => {
          setTimeout(() => {
            resolve(null)
          }, 2000)
        }),
      ])
      if (renamed === null) {
        voiceLogger.log(`Thread name update timed out`)
      } else if (renamed instanceof Error) {
        voiceLogger.log(`Could not update thread name:`, renamed.message)
      } else {
        voiceLogger.log(`Updated thread name to: "${threadName}"`)
      }
    }
  }

  await sendThreadMessage(
    thread,
    `📝 **Transcribed message:** ${escapeDiscordFormatting(text)}`,
  )
  return transcription
}

export function registerVoiceStateHandler({
  discordClient,
  appId,
}: {
  discordClient: Client
  appId: string
}) {
  discordClient.on(
    Events.VoiceStateUpdate,
    async (oldState: VoiceState, newState: VoiceState) => {
      try {
        const member = newState.member || oldState.member
        if (!member) return

        if (!hasKimakiBotPermission(member)) {
          return
        }

        const guild = newState.guild || oldState.guild

        if (oldState.channelId !== null && newState.channelId === null) {
          voiceLogger.log(
            `Permitted user ${member.user.tag} left voice channel: ${oldState.channel?.name}`,
          )

          const guildId = guild.id
          const voiceData = voiceConnections.get(guildId)

          if (
            voiceData &&
            voiceData.connection.joinConfig.channelId === oldState.channelId
          ) {
            const voiceChannel = oldState.channel as VoiceChannel
            if (!voiceChannel) return

            const hasOtherPermittedUsers = voiceChannel.members.some((m) => {
              if (m.id === member.id || m.user.bot) {
                return false
              }
              return hasKimakiBotPermission(m)
            })

            if (!hasOtherPermittedUsers) {
              voiceLogger.log(
                `No other permitted users in channel, bot leaving voice channel in guild: ${guild.name}`,
              )

              await cleanupVoiceConnection(guildId)
            } else {
              voiceLogger.log(
                `Other permitted users still in channel, bot staying in voice channel`,
              )
            }
          }
          return
        }

        if (
          oldState.channelId !== null &&
          newState.channelId !== null &&
          oldState.channelId !== newState.channelId
        ) {
          voiceLogger.log(
            `Permitted user ${member.user.tag} moved from ${oldState.channel?.name} to ${newState.channel?.name}`,
          )

          const guildId = guild.id
          const voiceData = voiceConnections.get(guildId)

          if (
            voiceData &&
            voiceData.connection.joinConfig.channelId === oldState.channelId
          ) {
            const oldVoiceChannel = oldState.channel as VoiceChannel
            if (oldVoiceChannel) {
              const hasOtherPermittedUsers = oldVoiceChannel.members.some(
                (m) => {
                  if (m.id === member.id || m.user.bot) {
                    return false
                  }
                  return hasKimakiBotPermission(m)
                },
              )

              if (!hasOtherPermittedUsers) {
                voiceLogger.log(
                  `Following admin to new channel: ${newState.channel?.name}`,
                )
                const voiceChannel = newState.channel as VoiceChannel
                if (voiceChannel) {
                  voiceData.connection.rejoin({
                    channelId: voiceChannel.id,
                    selfDeaf: false,
                    selfMute: false,
                  })
                }
              } else {
                voiceLogger.log(
                  `Other permitted users still in old channel, bot staying put`,
                )
              }
            }
          }
        }

        if (oldState.channelId === null && newState.channelId !== null) {
          voiceLogger.log(
            `Permitted user ${member.user.tag} joined voice channel: ${newState.channel?.name}`,
          )
        }

        if (newState.channelId === null) return

        const voiceChannel = newState.channel as VoiceChannel
        if (!voiceChannel) return

        const existingVoiceData = voiceConnections.get(newState.guild.id)
        if (
          existingVoiceData &&
          existingVoiceData.connection.state.status !==
            VoiceConnectionStatus.Destroyed
        ) {
          voiceLogger.log(
            `Bot already connected to a voice channel in guild ${newState.guild.name}`,
          )

          if (
            existingVoiceData.connection.joinConfig.channelId !==
            voiceChannel.id
          ) {
            voiceLogger.log(
              `Moving bot from channel ${existingVoiceData.connection.joinConfig.channelId} to ${voiceChannel.id}`,
            )
            existingVoiceData.connection.rejoin({
              channelId: voiceChannel.id,
              selfDeaf: false,
              selfMute: false,
            })
          }
          return
        }

        try {
          voiceLogger.log(
            `Attempting to join voice channel: ${voiceChannel.name} (${voiceChannel.id})`,
          )

          const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: newState.guild.id,
            adapterCreator: newState.guild.voiceAdapterCreator,
            selfDeaf: false,
            debug: true,
            // daveEncryption defaults to true, required by Discord since ~March 2026
            selfMute: false,
          })

          voiceConnections.set(newState.guild.id, { connection })

          await entersState(connection, VoiceConnectionStatus.Ready, 30_000)
          voiceLogger.log(
            `Successfully joined voice channel: ${voiceChannel.name} in guild: ${newState.guild.name}`,
          )

          await setupVoiceHandling({
            connection,
            guildId: newState.guild.id,
            channelId: voiceChannel.id,
            appId,
            discordClient,
          })

          connection.on(VoiceConnectionStatus.Disconnected, async () => {
            voiceLogger.log(
              `Disconnected from voice channel in guild: ${newState.guild.name}`,
            )
            try {
              await Promise.race([
                entersState(
                  connection,
                  VoiceConnectionStatus.Signalling,
                  5_000,
                ),
                entersState(
                  connection,
                  VoiceConnectionStatus.Connecting,
                  5_000,
                ),
              ])
              voiceLogger.log(`Reconnecting to voice channel`)
            } catch (error) {
              voiceLogger.log(`Failed to reconnect, destroying connection`)
              connection.destroy()
              voiceConnections.delete(newState.guild.id)
            }
          })

          connection.on(VoiceConnectionStatus.Destroyed, async () => {
            voiceLogger.log(
              `Connection destroyed for guild: ${newState.guild.name}`,
            )
            await cleanupVoiceConnection(newState.guild.id)
          })

          connection.on('error', (error) => {
            voiceLogger.error(
              `Connection error in guild ${newState.guild.name}:`,
              error,
            )
            void notifyError(error, `Voice connection error in guild ${newState.guild.name}`)
          })
        } catch (error) {
          voiceLogger.error(`Failed to join voice channel:`, error)
          void notifyError(error, 'Failed to join voice channel')
          await cleanupVoiceConnection(newState.guild.id)
        }
      } catch (error) {
        voiceLogger.error('Error in voice state update handler:', error)
        void notifyError(error, 'Voice state update handler error')
      }
    },
  )
}
