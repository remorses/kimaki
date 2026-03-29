#!/usr/bin/env node
/**
 * Test script for voice transcription using parakeet ASR service
 */

import { transcribeAudio } from './dist/voice.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function testTranscription() {
  const audioPath = path.join(__dirname, '../test-audio/voice-message.ogg')

  if (!fs.existsSync(audioPath)) {
    console.error(`❌ Audio file not found: ${audioPath}`)
    process.exit(1)
  }

  console.log('🎤 Testing Parakeet ASR transcription...')
  console.log(`📁 Audio file: ${audioPath}`)

  const audioBuffer = fs.readFileSync(audioPath)
  console.log(`📊 Audio size: ${audioBuffer.length} bytes`)

  try {
    const result = await transcribeAudio({
      audio: audioBuffer,
      provider: 'parakeet',
      mediaType: 'audio/ogg',
    })

    if (result instanceof Error) {
      console.error('❌ Transcription failed:', result.message)
      console.error('Stack:', result.stack)
      process.exit(1)
    }

    console.log('✅ Transcription successful!')
    console.log(`📝 Text: ${result.transcription}`)
    console.log(`📋 Queue message: ${result.queueMessage}`)
  } catch (error) {
    console.error('❌ Unexpected error:', error)
    process.exit(1)
  }
}

testTranscription()
