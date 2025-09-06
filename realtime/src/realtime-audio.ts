import { createRealtimeClient } from './openai-realtime'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const useAudio = process.argv.includes('--audio')

async function main() {
  const client = createRealtimeClient({
    apiKey: process.env.OPENAI_API_KEY,
  })

  client.on('error', (error) => {
    console.error('Error:', error)
  })

  client.on('session.created', (session) => {
    console.log('Session created:', session.id)
  })

  client.on('response.text.delta', (delta) => {
    process.stdout.write(delta)
  })

  client.on('response.text.done', (text) => {
    console.log('\nResponse complete')
  })

  client.on('response.audio.delta', (delta) => {
    if (useAudio) {
      const audioData = Buffer.from(delta, 'base64')
      playAudioChunk(audioData)
    }
  })

  client.on('response.audio_transcript.done', (transcript) => {
    console.log('\nAudio transcript:', transcript)
  })

  client.on('input_audio_buffer.speech_started', (startMs) => {
    console.log('Speech started at:', startMs, 'ms')
  })

  client.on('input_audio_buffer.speech_stopped', (endMs) => {
    console.log('Speech stopped at:', endMs, 'ms')
  })

  await client.connect()

  client.updateSession({
    instructions:
      'You are a helpful AI assistant. Respond concisely and clearly.',
    voice: 'alloy',
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    input_audio_transcription: {
      model: 'whisper-1',
    },
    turn_detection: {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 200,
    },
    temperature: 0.8,
  })

  await client.waitForSessionCreated()

  if (useAudio) {
    console.log('Audio mode enabled. Recording audio input...')
    startAudioRecording(client)
  } else {
    console.log('Text mode enabled. Type your messages:')
    startTextInput(client)
  }
}

function startTextInput(client: ReturnType<typeof createRealtimeClient>) {
  const readline = require('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  rl.on('line', (input: string) => {
    if (input.toLowerCase() === 'exit') {
      client.disconnect()
      process.exit(0)
    }

    client.sendUserMessageContent([{ type: 'input_text', text: input }])
    client.createResponse()
  })

  console.log('Type your message (or "exit" to quit):')
}

function startAudioRecording(client: ReturnType<typeof createRealtimeClient>) {
  const sox = spawn('sox', [
    '-d',
    '-t',
    'raw',
    '-e',
    'signed-integer',
    '-b',
    '16',
    '-c',
    '1',
    '-r',
    '24000',
    '-',
  ])

  sox.stdout.on('data', (chunk: Buffer) => {
    const base64Audio = chunk.toString('base64')
    client.appendInputAudio(base64Audio)
  })

  sox.stderr.on('data', (data) => {
    console.error('Recording error:', data.toString())
  })

  sox.on('close', (code) => {
    console.log('Recording stopped with code:', code)
  })

  process.on('SIGINT', () => {
    sox.kill()
    client.disconnect()
    process.exit(0)
  })

  console.log('Recording... Press Ctrl+C to stop')
}

function playAudioChunk(audioData: Buffer) {
  const play = spawn('play', [
    '-t',
    'raw',
    '-e',
    'signed-integer',
    '-b',
    '16',
    '-c',
    '1',
    '-r',
    '24000',
    '-',
  ])

  play.stdin.write(audioData)
  play.stdin.end()
}

main().catch(console.error)
