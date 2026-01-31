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
  PermissionsBitField,
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
  findTextChannelByVoiceChannel,
} from './database.js'
import {
  sendThreadMessage,
  escapeDiscordFormatting,
  SILENT_MESSAGE_FLAGS,
} from './discord-utils.js'
import { transcribeAudio } from './voice.js'
import { FetchError } from './errors.js'

import { createLogger, LogPrefix } from './logger.js'

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
  const audioDir = path.join(process.cwd(), 'discord-audio-logs', guildId, channelId)

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
  voiceLogger.log(`Setting up voice handling for guild ${guildId}, channel ${channelId}`)

  const directory = await getVoiceChannelDirectory(channelId)

  if (!directory) {
    voiceLogger.log(`Voice channel ${channelId} has no associated directory, skipping setup`)
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
      const text = params.error
        ? `<systemMessage>\nThe coding agent encountered an error while processing session ${params.sessionId}: ${params.error?.message || String(params.error)}\n</systemMessage>`
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
              content: `⚠️ Voice session error: ${error}`,
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

    const pipeline = audioStream.pipe(decoder).pipe(downsampleTransform).pipe(framer)

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
          voiceLogger.log(`User ${userId} stopped speaking (session ${currentSessionCount})`)
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
      })

    audioStream.on('error', (error) => {
      voiceLogger.error(`Audio stream error for user ${userId}:`, error)
    })

    downsampleTransform.on('error', (error) => {
      voiceLogger.error(`Downsample transform error for user ${userId}:`, error)
    })

    framer.on('error', (error) => {
      voiceLogger.error(`Framer error for user ${userId}:`, error)
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

export async function processVoiceAttachment({
  message,
  thread,
  projectDirectory,
  isNewThread = false,
  appId,
  currentSessionContext,
  lastSessionContext,
}: {
  message: Message
  thread: ThreadChannel
  projectDirectory?: string
  isNewThread?: boolean
  appId?: string
  currentSessionContext?: string
  lastSessionContext?: string
}): Promise<string | null> {
  const audioAttachment = Array.from(message.attachments.values()).find((attachment) =>
    attachment.contentType?.startsWith('audio/'),
  )

  if (!audioAttachment) return null

  voiceLogger.log(
    `Detected audio attachment: ${audioAttachment.name} (${audioAttachment.contentType})`,
  )

  await sendThreadMessage(thread, '🎤 Transcribing voice message...')

  const audioResponse = await errore.tryAsync({
    try: () => fetch(audioAttachment.url),
    catch: (e) => new FetchError({ url: audioAttachment.url, cause: e }),
  })
  if (audioResponse instanceof Error) {
    voiceLogger.error(`Failed to download audio attachment:`, audioResponse.message)
    await sendThreadMessage(thread, `⚠️ Failed to download audio: ${audioResponse.message}`)
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

  let geminiApiKey: string | undefined
  if (appId) {
    const apiKey = await getGeminiApiKey(appId)
    if (apiKey) {
      geminiApiKey = apiKey
    }
  }

  if (!geminiApiKey && !process.env.GEMINI_API_KEY) {
    if (appId) {
      const button = new ButtonBuilder()
        .setCustomId(`gemini_apikey:${appId}`)
        .setLabel('Set Gemini API Key')
        .setStyle(ButtonStyle.Primary)

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button)

      await thread.send({
        content:
          'Voice transcription requires a Gemini API key. Get one at https://aistudio.google.com/apikey. The key will be stored and used for future voice messages.',
        components: [row],
        flags: SILENT_MESSAGE_FLAGS,
      })
    } else {
      await sendThreadMessage(
        thread,
        'Voice transcription requires a Gemini API key. Get one at https://aistudio.google.com/apikey and set it with /login in this channel.',
      )
    }
    return null
  }

  const transcription = await transcribeAudio({
    audio: audioBuffer,
    prompt: transcriptionPrompt,
    geminiApiKey,
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

  voiceLogger.log(
    `Transcription successful: "${transcription.slice(0, 50)}${transcription.length > 50 ? '...' : ''}"`,
  )

  if (isNewThread) {
    const threadName = transcription.replace(/\s+/g, ' ').trim().slice(0, 80)
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
    `📝 **Transcribed message:** ${escapeDiscordFormatting(transcription)}`,
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
  discordClient.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
    try {
      const member = newState.member || oldState.member
      if (!member) return

      const guild = newState.guild || oldState.guild
      const isOwner = member.id === guild.ownerId
      const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator)
      const canManageServer = member.permissions.has(PermissionsBitField.Flags.ManageGuild)
      const hasKimakiRole = member.roles.cache.some((role) => role.name.toLowerCase() === 'kimaki')

      if (!isOwner && !isAdmin && !canManageServer && !hasKimakiRole) {
        return
      }

      if (oldState.channelId !== null && newState.channelId === null) {
        voiceLogger.log(
          `Admin user ${member.user.tag} left voice channel: ${oldState.channel?.name}`,
        )

        const guildId = guild.id
        const voiceData = voiceConnections.get(guildId)

        if (voiceData && voiceData.connection.joinConfig.channelId === oldState.channelId) {
          const voiceChannel = oldState.channel as VoiceChannel
          if (!voiceChannel) return

          const hasOtherAdmins = voiceChannel.members.some((m) => {
            if (m.id === member.id || m.user.bot) return false
            return (
              m.id === guild.ownerId ||
              m.permissions.has(PermissionsBitField.Flags.Administrator) ||
              m.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
              m.roles.cache.some((role) => role.name.toLowerCase() === 'kimaki')
            )
          })

          if (!hasOtherAdmins) {
            voiceLogger.log(
              `No other admins in channel, bot leaving voice channel in guild: ${guild.name}`,
            )

            await cleanupVoiceConnection(guildId)
          } else {
            voiceLogger.log(`Other admins still in channel, bot staying in voice channel`)
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
          `Admin user ${member.user.tag} moved from ${oldState.channel?.name} to ${newState.channel?.name}`,
        )

        const guildId = guild.id
        const voiceData = voiceConnections.get(guildId)

        if (voiceData && voiceData.connection.joinConfig.channelId === oldState.channelId) {
          const oldVoiceChannel = oldState.channel as VoiceChannel
          if (oldVoiceChannel) {
            const hasOtherAdmins = oldVoiceChannel.members.some((m) => {
              if (m.id === member.id || m.user.bot) return false
              return (
                m.id === guild.ownerId ||
                m.permissions.has(PermissionsBitField.Flags.Administrator) ||
                m.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
                m.roles.cache.some((role) => role.name.toLowerCase() === 'kimaki')
              )
            })

            if (!hasOtherAdmins) {
              voiceLogger.log(`Following admin to new channel: ${newState.channel?.name}`)
              const voiceChannel = newState.channel as VoiceChannel
              if (voiceChannel) {
                voiceData.connection.rejoin({
                  channelId: voiceChannel.id,
                  selfDeaf: false,
                  selfMute: false,
                })
              }
            } else {
              voiceLogger.log(`Other admins still in old channel, bot staying put`)
            }
          }
        }
      }

      if (oldState.channelId === null && newState.channelId !== null) {
        voiceLogger.log(
          `Admin user ${member.user.tag} (Owner: ${isOwner}, Admin: ${isAdmin}) joined voice channel: ${newState.channel?.name}`,
        )
      }

      if (newState.channelId === null) return

      const voiceChannel = newState.channel as VoiceChannel
      if (!voiceChannel) return

      const existingVoiceData = voiceConnections.get(newState.guild.id)
      if (
        existingVoiceData &&
        existingVoiceData.connection.state.status !== VoiceConnectionStatus.Destroyed
      ) {
        voiceLogger.log(`Bot already connected to a voice channel in guild ${newState.guild.name}`)

        if (existingVoiceData.connection.joinConfig.channelId !== voiceChannel.id) {
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
          daveEncryption: false,
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
          voiceLogger.log(`Disconnected from voice channel in guild: ${newState.guild.name}`)
          try {
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ])
            voiceLogger.log(`Reconnecting to voice channel`)
          } catch (error) {
            voiceLogger.log(`Failed to reconnect, destroying connection`)
            connection.destroy()
            voiceConnections.delete(newState.guild.id)
          }
        })

        connection.on(VoiceConnectionStatus.Destroyed, async () => {
          voiceLogger.log(`Connection destroyed for guild: ${newState.guild.name}`)
          await cleanupVoiceConnection(newState.guild.id)
        })

        connection.on('error', (error) => {
          voiceLogger.error(`Connection error in guild ${newState.guild.name}:`, error)
        })
      } catch (error) {
        voiceLogger.error(`Failed to join voice channel:`, error)
        await cleanupVoiceConnection(newState.guild.id)
      }
    } catch (error) {
      voiceLogger.error('Error in voice state update handler:', error)
    }
  })
}
