#!/usr/bin/env node
import webrtc from '@roamhq/wrtc'
import { spawn, ChildProcess } from 'node:child_process'

/**
 * OpenAI Realtime API - Single file implementation
 */

const SAMPLE_RATE = 24000 // Default sample rate (OpenAI might use 24kHz)
const CHANNELS = 1

// Hardcoded weather data
const weatherData: Record<string, { temp: number; condition: string }> = {
  'new york': { temp: 72, condition: 'Partly cloudy' },
  'san francisco': { temp: 65, condition: 'Foggy' },
  london: { temp: 59, condition: 'Rainy' },
  tokyo: { temp: 78, condition: 'Clear' },
  paris: { temp: 68, condition: 'Overcast' },
  sydney: { temp: 75, condition: 'Sunny' },
  default: { temp: 70, condition: 'Clear' },
}

function getWeather(location: string, unit = 'fahrenheit') {
  const weather = weatherData[location.toLowerCase()] || weatherData['default']
  let temp = weather.temp
  if (unit === 'celsius') {
    temp = Math.round(((temp - 32) * 5) / 9)
  }
  return {
    location,
    temperature: temp,
    unit,
    condition: weather.condition,
    timestamp: new Date().toISOString(),
  }
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY required')
  }

  console.log('🚀 OpenAI Realtime API Client')
  console.log('==============================')

  // Create peer connection
  const pc = new webrtc.RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })

  // Audio handling
  const audioSource = new webrtc.nonstandard.RTCAudioSource()
  const audioTrack = audioSource.createTrack()
  pc.addTrack(audioTrack)

  let audioBuffer: Buffer[] = []
  let playProcess: ChildProcess | null = null
  let isPlaying = false
  let detectedSampleRate = SAMPLE_RATE

  // Handle incoming audio
  pc.ontrack = (e: any) => {
    console.log('📻 Track received:', e.track.kind)

    if (e.track.kind === 'audio') {
      const audioSink = new webrtc.nonstandard.RTCAudioSink(e.track)
      let firstData = true

      audioSink.ondata = (data: any) => {
        // Log the actual sample rate from the data
        if (firstData) {
          detectedSampleRate = data.sampleRate
          console.log(`🎵 Audio sample rate: ${detectedSampleRate}Hz`)
          console.log(`   Channels: ${data.channelCount || 1}`)
          console.log(`   Bits per sample: ${data.bitsPerSample || 16}`)
          firstData = false
        }

        // Collect audio data
        const buffer = Buffer.from(data.samples.buffer)
        audioBuffer.push(buffer)

        // Play when we have enough
        if (!isPlaying && audioBuffer.length > 10) {
          playAudio()
        }
      }
    }
  }

  // Play audio function
  function playAudio() {
    if (isPlaying || audioBuffer.length === 0) return
    isPlaying = true

    console.log(`🔊 Playing audio at ${detectedSampleRate}Hz...`)

    const audioData = Buffer.concat(audioBuffer)
    audioBuffer = []

    const isMac = process.platform === 'darwin'

    // Use play command on mac, aplay on linux - with detected sample rate
    playProcess = spawn(isMac ? 'play' : 'aplay', [
      ...(isMac
        ? [
            '-t',
            'raw',
            '-r',
            detectedSampleRate.toString(), // Use detected sample rate
            '-e',
            'signed-integer',
            '-b',
            '16',
            '-c',
            '1',
            '-q',
            '-',
          ]
        : [
            '-f',
            'S16_LE',
            '-r',
            detectedSampleRate.toString(),
            '-c',
            '1',
            '-q',
            '-t',
            'raw',
            '-',
          ]),
    ])

    playProcess.on('close', () => {
      isPlaying = false
      if (audioBuffer.length > 0) {
        setTimeout(playAudio, 100)
      }
    })

    playProcess.on('error', (err) => {
      console.error('Audio play error:', err.message)
      console.log('Install sox (mac) or alsa-utils (linux)')
      isPlaying = false
    })

    // Handle EPIPE errors properly
    playProcess.stdin?.on('error', (err: any) => {
      if (err.code !== 'EPIPE') {
        console.error('Stdin error:', err.message)
      }
    })

    // Write data more carefully
    try {
      if (playProcess.stdin?.writable) {
        playProcess.stdin.write(audioData)
        playProcess.stdin.end()
      }
    } catch (err: any) {
      if (err.code !== 'EPIPE') {
        console.error('Write error:', err.message)
      }
      isPlaying = false
    }
  }

  // Create data channel
  const dc = pc.createDataChannel('oai-events')

  dc.onopen = () => {
    console.log('✅ Data channel open')

    // Configure session
    dc.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          instructions:
            'You are a helpful assistant. Respond with audio and text.',
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              description: 'Get weather for a location',
              parameters: {
                type: 'object',
                properties: {
                  location: { type: 'string' },
                  unit: { type: 'string', enum: ['fahrenheit', 'celsius'] },
                },
                required: ['location'],
              },
            },
          ],
          temperature: 0.8,
        },
      }),
    )

    // Send greeting
    setTimeout(() => {
      dc.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
            instructions: 'Say hello and that you can help with weather',
          },
        }),
      )
    }, 500)

    // Example message
    setTimeout(() => {
      console.log('\n📤 Sending text message...')
      dc.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: "What's the weather in Tokyo?",
              },
            ],
          },
        }),
      )

      setTimeout(() => {
        dc.send(JSON.stringify({ type: 'response.create' }))
      }, 100)
    }, 5000)
  }

  // Handle messages
  dc.onmessage = (e: any) => {
    try {
      const event = JSON.parse(e.data)

      switch (event.type) {
        case 'session.created':
        case 'session.updated':
          console.log('✅ Session ready')
          break

        case 'response.text.delta':
          process.stdout.write(event.delta)
          break

        case 'response.text.done':
          console.log()
          break

        case 'response.output_item.done':
          if (event.item?.type === 'function_call') {
            console.log('🔧 Function call:', event.item.name)
            const args = JSON.parse(event.item.arguments || '{}')
            const result = getWeather(args.location, args.unit)
            console.log('🌤️ Result:', result)

            dc.send(
              JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: event.item.call_id,
                  output: JSON.stringify(result),
                },
              }),
            )

            setTimeout(() => {
              dc.send(JSON.stringify({ type: 'response.create' }))
            }, 100)
          }
          break

        case 'response.done':
          if (event.response?.usage) {
            console.log('📊 Tokens:', event.response.usage.total_tokens)
          }
          break

        case 'error':
          console.error('❌ Error:', event.error)
          break
      }
    } catch (err) {
      // Ignore parse errors
    }
  }

  // Create offer and connect
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  console.log('🔌 Connecting to OpenAI...')

  const resp = await fetch(
    'https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    },
  )

  if (!resp.ok) {
    throw new Error(`API error: ${resp.status}`)
  }

  const answerSdp = await resp.text()
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })

  console.log('🎯 Connected!\n')

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\n👋 Closing...')
    if (playProcess) playProcess.kill()
    pc.close()
    process.exit(0)
  })

  // Keep alive
  await new Promise(() => {})
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err)
    process.exit(1)
  })
}
