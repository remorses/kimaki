import { cac } from 'cac'
import dedent from 'string-dedent'
// @ts-expect-error still not typed https://github.com/ircam-ismm/node-web-audio-api/issues/73
import { mediaDevices } from 'node-web-audio-api'
import { MediaResolution, Modality } from '@google/genai'
import * as webAudioApi from 'node-web-audio-api'
import fs from 'node:fs'
import path from 'node:path'
import WaveFile from 'wavefile'
import pc from 'picocolors'
import { getTools } from './tools.js'
import { render, Box, Text, useStdout } from 'ink'
import React, { useState, useEffect } from 'react'

export const cli = cac('kimaki')

cli.help()

// ASCII Video Player Component
function AsciiVideoPlayer() {
  const [frameIndex, setFrameIndex] = useState(0)
  const [asciiFrame, setAsciiFrame] = useState('Loading frames...')
  const [frames, setFrames] = useState<string[]>([])
  const { stdout } = useStdout()

  useEffect(() => {
    // Load all frame paths
    const framesDir = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '../assets/frames',
    )
    try {
      const files = fs
        .readdirSync(framesDir)
        .filter((f) => f.endsWith('.png'))
        .sort()
      setFrames(files.map((f) => path.join(framesDir, f)))
    } catch (error) {
      setAsciiFrame('Error: Could not find frames directory')
    }
  }, [])

  useEffect(() => {
    if (frames.length === 0) return

    // Convert current frame to ASCII
    const loadFrame = async () => {
      const { convertImageToAscii } = await import('./video-to-ascii.js')
      // Use fixed dimensions that work well in terminal
      const ascii = await convertImageToAscii({
        imagePath: frames[frameIndex],
        cols: 80,
        rows: 22, // 24 terminal rows - 2 for status
        colored: true,
        keepAspectRatio: false,
      })
      setAsciiFrame(ascii)
    }

    loadFrame()

    // Advance to next frame
    const timer = setTimeout(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length)
    }, 50) // 20 FPS = 50ms per frame

    return () => clearTimeout(timer)
  }, [frameIndex, frames])

  return (
    <Box flexDirection='column'>
      <Text>{asciiFrame}</Text>
      <Text dimColor>
        Press Ctrl+C to exit • Frame {frameIndex + 1}/{frames.length}
      </Text>
    </Box>
  )
}

// KimakiTUI Component
function KimakiTUI({
  messages,
  isConnected,
}: {
  messages: any[]
  isConnected: boolean
}) {
  const formatMessage = (msg: any) => {
    const data = msg.data
    if (data.serverContent?.modelTurn?.parts?.[0]?.text) {
      return `🤖 ${data.serverContent.modelTurn.parts[0].text.slice(0, 80)}...`
    }
    if (data.serverContent?.turnComplete) {
      return '✅ Turn completed'
    }
    if (data.toolCall) {
      return `🔧 Tool: ${data.toolCall.name}`
    }
    if (data.toolResponse) {
      return `📦 Tool response received`
    }
    if (data.interrupted) {
      return '⚠️ Interrupted'
    }
    if (data.setupComplete) {
      return '🚀 Setup complete'
    }
    return JSON.stringify(data).slice(0, 80)
  }

  return (
    <Box flexDirection='column' paddingX={1}>
      <Box borderStyle='single' paddingX={1} marginBottom={1}>
        <Text color={isConnected ? 'green' : 'yellow'}>
          Kimaki Voice Assistant -{' '}
          {isConnected ? '● Connected to Gemini Live API' : '⏳ Connecting...'}
        </Text>
      </Box>

      <Box borderStyle='single' paddingX={1} flexDirection='column'>
        <Text color='white' bold>
          Debug Messages:
        </Text>
        <Box flexDirection='column' marginTop={1}>
          {messages.length === 0 ? (
            <Text dimColor>No messages yet...</Text>
          ) : (
            messages.slice(-15).map((msg, index) => (
              <Box key={index} marginBottom={0}>
                <Text color='cyan'>
                  [{new Date(msg.timestamp).toLocaleTimeString()}]{' '}
                </Text>
                <Text color='white'>{formatMessage(msg)}</Text>
              </Box>
            ))
          )}
        </Box>
      </Box>
    </Box>
  )
}

// Check if running in TTY environment
cli
  .command('', 'Spawn Kimaki to orchestrate code agents')
  .action(async (options) => {
    try {
      const token = process.env.GEMINI_API_KEY

      Object.assign(globalThis, webAudioApi)
      // @ts-expect-error still not typed https://github.com/ircam-ismm/node-web-audio-api/issues/73
      navigator.mediaDevices = mediaDevices

      const { LiveAPIClient, callableToolsFromObject } = await import(
        'liveapi/src/index'
      )

      let liveApiClient: InstanceType<typeof LiveAPIClient> | null = null
      let audioChunks: ArrayBuffer[] = []
      let isModelSpeaking = false
      let debugMessages: any[] = []
      let isConnected = false
      let updateUI: ((messages: any[], connected: boolean) => void) | null =
        null

      const { tools, providers, preferredModel } = await getTools({
        onMessageCompleted: (params) => {
          if (!liveApiClient) return

          const text = params.error
            ? `<systemMessage>\nChat message failed for session ${params.sessionId}. Error: ${params.error?.message || String(params.error)}\n</systemMessage>`
            : `<systemMessage>\nChat message completed for session ${params.sessionId}.\n\nAssistant response:\n${params.markdown}\n</systemMessage>`

          liveApiClient.sendText(text)
        },
      })

      const saveUserAudio = async () => {
        console.log('saveUserAudio', audioChunks.length)
        if (audioChunks.length === 0) return

        try {
          const timestamp = Date.now()
          const dir = 'useraudio'

          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
          }

          // Combine all ArrayBuffer chunks
          const totalLength = audioChunks.reduce(
            (acc, chunk) => acc + chunk.byteLength,
            0,
          )
          const combinedBuffer = new ArrayBuffer(totalLength)
          const combinedView = new Int16Array(combinedBuffer)

          let offset = 0
          for (const chunk of audioChunks) {
            const chunkView = new Int16Array(chunk)
            combinedView.set(chunkView, offset)
            offset += chunkView.length
          }

          // Create WAV file
          const wav = new WaveFile.WaveFile()
          wav.fromScratch(1, 16000, '16', Array.from(combinedView))

          const filename = path.join(dir, `${timestamp}.wav`)
          await fs.promises.writeFile(filename, Buffer.from(wav.toBuffer()))
          console.log(
            `Saved user audio to ${filename} (${audioChunks.length} chunks)`,
          )

          // Clear chunks after saving
          audioChunks = []
        } catch (error) {
          console.error('Failed to save audio file:', error)
        }
      }
      const model = 'models/gemini-2.5-flash-live-preview'

      const newClient = new LiveAPIClient({
        apiKey: token!,
        model,
        recordingSampleRate: 44100,
        autoMuteOnAssistantSpeaking: false, // Allow interruptions while model is speaking
        onUserAudioChunk: (chunk) => {
          // Collect chunks while user is speaking
          if (!isModelSpeaking) {
            audioChunks.push(chunk)
          }
        },
        onMessage: (message) => {
          // Add message to debug array
          debugMessages.push({
            timestamp: Date.now(),
            data: message,
          })

          // Keep only last 50 messages
          if (debugMessages.length > 50) {
            debugMessages = debugMessages.slice(-50)
          }

          // Update UI
          if (updateUI) {
            updateUI([...debugMessages], isConnected)
          }

          process.env.DEBUG && console.log(message)
          // When model starts responding, save the user's audio
          if (message.serverContent?.turnComplete && audioChunks.length > 0) {
            isModelSpeaking = true
            process.env.DEBUG && saveUserAudio()
          }
          // Reset when turn is complete
          if (message.serverContent?.turnComplete) {
            isModelSpeaking = false
          }
        },
        config: {
          tools: callableToolsFromObject(tools),
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Charon', // Orus also not bad
              },
            },
          },
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,

          contextWindowCompression: {
            triggerTokens: '25600',
            slidingWindow: { targetTokens: '12800' },
          },
          systemInstruction: {
            parts: [
              {
                text: dedent`
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
              },
            ],
          },
        },
        onStateChange: (state) => {},
      })

      liveApiClient = newClient

      // Connect to the API first
      const connected = await newClient.connect()
      isConnected = true

      // Wait a moment for connection to stabilize
      await new Promise((res) => setTimeout(res, 500))

      // Render the TUI after everything is ready
      const App = () => {
        const [messages, setMessages] = useState<any[]>([])
        const [connectionStatus, setConnectionStatus] = useState(isConnected)

        useEffect(() => {
          updateUI = (msgs, connected) => {
            setMessages(msgs)
            setConnectionStatus(connected)
          }

          // Set initial state
          setMessages([...debugMessages])
          setConnectionStatus(isConnected)

          // Return cleanup function
          return () => {
            updateUI = null
          }
        }, [])

        return <KimakiTUI messages={messages} isConnected={connectionStatus} />
      }

      render(<App />)

      // Send initial greeting if needed
      // liveApiClient.sendText(`<systemMessage>\nsay "Hello boss, how we doing today?"\n</systemMessage>`)
    } catch (error) {
      console.error(pc.red('\nError initializing project:'))
      console.error(pc.red(error))
      process.exit(1)
    }
  })

cli.command('ascii', 'Play ASCII video').action(async () => {
  render(<AsciiVideoPlayer />)
})
