// Tests for voice transcription using AI SDK provider (LanguageModelV3).
// Uses the example audio files at scripts/example-audio.{mp3,ogg}.

import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  transcribeAudio,
  convertOggToWav,
  extractTranscription,
  normalizeAudioMediaType,
  getOpenAIAudioConversionStrategy,
} from './voice.js'
import {
  getVoiceAttachmentMatchReason,
  isVoiceAttachment,
} from './voice-attachment.js'

describe('audio media type routing', () => {
  test('normalizes m4a aliases to audio/mp4', () => {
    expect(normalizeAudioMediaType('audio/x-m4a')).toMatchInlineSnapshot('"audio/mp4"')
    expect(normalizeAudioMediaType('audio/m4a')).toMatchInlineSnapshot('"audio/mp4"')
  })

  test('keeps non-m4a media types unchanged', () => {
    expect(normalizeAudioMediaType('audio/ogg')).toMatchInlineSnapshot('"audio/ogg"')
    expect(normalizeAudioMediaType('audio/wav')).toMatchInlineSnapshot('"audio/wav"')
  })

  test('converts ogg only when mime is actual ogg/opus', () => {
    expect(getOpenAIAudioConversionStrategy('audio/ogg')).toMatchInlineSnapshot('"convert-ogg-to-wav"')
    expect(getOpenAIAudioConversionStrategy('audio/opus')).toMatchInlineSnapshot('"convert-ogg-to-wav"')
    expect(getOpenAIAudioConversionStrategy('audio/mp4')).toMatchInlineSnapshot('"convert-m4a-to-wav"')
    expect(getOpenAIAudioConversionStrategy('audio/mpeg')).toMatchInlineSnapshot('"none"')
  })
})

describe('voice attachment detection', () => {
  test('detects voice attachments by content type, extension, and waveform metadata', () => {
    expect(
      [
        getVoiceAttachmentMatchReason({
          name: 'voice-message.ogg',
          contentType: 'audio/ogg',
        }),
        getVoiceAttachmentMatchReason({
          name: 'voice-message.ogg',
          contentType: null,
        }),
        getVoiceAttachmentMatchReason({
          name: 'upload.bin',
          contentType: null,
          waveform: 'abc123',
        }),
        isVoiceAttachment({
          name: 'notes.txt',
          contentType: null,
        }),
      ]).toMatchInlineSnapshot(`
      [
        "contentType:audio/ogg",
        "extension:.ogg",
        "waveform",
        false,
      ]
    `)
  })
})

describe('extractTranscription', () => {
  test('extracts transcription from tool call', () => {
    const result = extractTranscription([
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'transcriptionResult',
        input: JSON.stringify({ transcription: 'hello world' }),
      },
    ])
    expect(result).toMatchInlineSnapshot(`
      {
        "queueMessage": false,
        "transcription": "hello world",
      }
    `)
  })

  test('extracts queueMessage: true from tool call', () => {
    const result = extractTranscription([
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'transcriptionResult',
        input: JSON.stringify({
          transcription: 'Fix the login bug in auth.ts',
          queueMessage: true,
        }),
      },
    ])
    expect(result).toMatchInlineSnapshot(`
      {
        "queueMessage": true,
        "transcription": "Fix the login bug in auth.ts",
      }
    `)
  })

  test('queueMessage defaults to false when omitted', () => {
    const result = extractTranscription([
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'transcriptionResult',
        input: JSON.stringify({ transcription: 'regular message' }),
      },
    ])
    expect(result).not.toBeInstanceOf(Error)
    expect((result as { queueMessage: boolean }).queueMessage).toBe(false)
  })

  test('falls back to text when no tool call', () => {
    const result = extractTranscription([
      {
        type: 'text',
        text: 'fallback text response',
      },
    ])
    expect(result).toMatchInlineSnapshot(`
      {
        "queueMessage": false,
        "transcription": "fallback text response",
      }
    `)
  })

  test('returns NoResponseContentError for empty content', () => {
    const result = extractTranscription([])
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatchInlineSnapshot(
      `"No response content from model"`,
    )
  })

  test('returns EmptyTranscriptionError for empty transcription string', () => {
    const result = extractTranscription([
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'transcriptionResult',
        input: JSON.stringify({ transcription: '   ' }),
      },
    ])
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatchInlineSnapshot(
      `"Model returned empty transcription"`,
    )
  })

  test('returns TranscriptionError when content has no tool call or text', () => {
    const result = extractTranscription([
      {
        type: 'reasoning',
        text: 'thinking about it',
      },
    ])
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatchInlineSnapshot(
      `"Transcription failed: Model did not produce a transcription"`,
    )
  })
})

describe('transcribeAudio with real API', () => {
  const audioPath = path.join(
    import.meta.dirname,
    '..',
    'scripts',
    'example-audio.mp3',
  )

  test('transcribes with Gemini', { timeout: 30_000 }, async () => {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      console.log('Skipping: GEMINI_API_KEY not set')
      return
    }
    if (!fs.existsSync(audioPath)) {
      console.log('Skipping: example-audio.mp3 not found')
      return
    }

    const audio = fs.readFileSync(audioPath)
    const result = await transcribeAudio({
      audio,
      prompt: 'test project',
      apiKey,
      provider: 'gemini',
    })

    expect(result).not.toBeInstanceOf(Error)
    const { transcription } = result as { transcription: string }
    expect(transcription.length).toBeGreaterThan(0)
    console.log('Gemini transcription:', result)
  })

  test('transcribes with OpenAI', { timeout: 30_000 }, async () => {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      console.log('Skipping: OPENAI_API_KEY not set')
      return
    }
    if (!fs.existsSync(audioPath)) {
      console.log('Skipping: example-audio.mp3 not found')
      return
    }

    const audio = fs.readFileSync(audioPath)
    const result = await transcribeAudio({
      audio,
      prompt: 'test project',
      apiKey,
      provider: 'openai',
    })

    expect(result).not.toBeInstanceOf(Error)
    const { transcription } = result as { transcription: string }
    expect(transcription.length).toBeGreaterThan(0)
    console.log('OpenAI transcription:', result)
  })

  test('transcribes OGG with OpenAI (converts to WAV)', { timeout: 30_000 }, async () => {
    const apiKey = process.env.OPENAI_API_KEY
    const oggPath = path.join(import.meta.dirname, '..', 'scripts', 'example-audio.ogg')
    if (!apiKey) {
      console.log('Skipping: OPENAI_API_KEY not set')
      return
    }
    if (!fs.existsSync(oggPath)) {
      console.log('Skipping: example-audio.ogg not found')
      return
    }

    const audio = fs.readFileSync(oggPath)
    const result = await transcribeAudio({
      audio,
      prompt: 'test project',
      apiKey,
      provider: 'openai',
      mediaType: 'audio/ogg',
    })

    expect(result).not.toBeInstanceOf(Error)
    const { transcription } = result as { transcription: string }
    expect(transcription.length).toBeGreaterThan(0)
    console.log('OpenAI OGG transcription:', result)
  })
})

describe('convertOggToWav', () => {
  test('converts OGG Opus to valid WAV', async () => {
    const oggPath = path.join(import.meta.dirname, '..', 'scripts', 'example-audio.ogg')
    if (!fs.existsSync(oggPath)) {
      console.log('Skipping: example-audio.ogg not found')
      return
    }

    const ogg = fs.readFileSync(oggPath)
    const result = await convertOggToWav(ogg)
    expect(result).toBeInstanceOf(Buffer)

    const wav = result as Buffer
    // WAV header starts with RIFF
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.subarray(8, 12).toString()).toBe('WAVE')
    // Must be larger than just the header (44 bytes)
    expect(wav.length).toBeGreaterThan(44)
    console.log(`Converted OGG (${ogg.length} bytes) to WAV (${wav.length} bytes)`)
  })
})
