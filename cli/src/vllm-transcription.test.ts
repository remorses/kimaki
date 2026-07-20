import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { transcribeWithVLLM } from './voice.js'
import { TranscriptionError, EmptyTranscriptionError } from './errors.js'

describe('vLLM Transcription', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    mockFetch.mockReset()
    global.fetch = mockFetch as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('transcribeWithVLLM', () => {
    const audioBuffer = Buffer.from('fake audio data')
    const validVLLMResponse = {
      text: 'Hello, this is a test transcription',
      duration: 2.5,
      language: 'en',
    }

    // Helper: set up fetch mock to handle health check + transcription call
    // checkVLLMServiceRunning() calls GET baseUrl/v1/models, then transcribe calls POST baseUrl/v1/audio/transcriptions
    function mockHealthOkAndTranscribe(transcriptionResponse: Partial<Response>) {
      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/v1/models')) {
          return { ok: true } as Response
        }
        return transcriptionResponse as Response
      })
    }

    test('should transcribe audio successfully', async () => {
      mockHealthOkAndTranscribe({
        ok: true,
        json: async () => validVLLMResponse,
      })

      const result = await transcribeWithVLLM({
        audio: audioBuffer,
        mediaType: 'audio/wav',
      })

      // Check it's not an error (success case)
      expect(result).not.toBeInstanceOf(Error)
      if ('transcription' in result) {
        expect(result.transcription).toBe('Hello, this is a test transcription')
        expect(result.queueMessage).toBe(false)
      }
    })

    test('should handle OGG audio format', async () => {
      mockHealthOkAndTranscribe({
        ok: true,
        json: async () => ({ ...validVLLMResponse, text: 'OGG transcription' }),
      })

      const result = await transcribeWithVLLM({
        audio: audioBuffer,
        mediaType: 'audio/ogg',
      })

      expect(result).not.toBeInstanceOf(Error)
      if ('transcription' in result) {
        expect(result.transcription).toBe('OGG transcription')
      }
    })

    test('should return TranscriptionError when service returns error', async () => {
      mockHealthOkAndTranscribe({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      })

      const result = await transcribeWithVLLM({
        audio: audioBuffer,
        mediaType: 'audio/wav',
      })

      expect(result).toBeInstanceOf(TranscriptionError)
      if (result instanceof TranscriptionError) {
        expect(result.message).toContain('vLLM transcription error')
      }
    })

    test('should return EmptyTranscriptionError when transcription is empty', async () => {
      mockHealthOkAndTranscribe({
        ok: true,
        json: async () => ({ text: '' }),
      })

      const result = await transcribeWithVLLM({
        audio: audioBuffer,
        mediaType: 'audio/wav',
      })

      expect(result).toBeInstanceOf(EmptyTranscriptionError)
    })

    test('should handle connection refused error on transcription call', async () => {
      // Health check succeeds, but transcription call fails
      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/v1/models')) {
          return { ok: true } as Response
        }
        throw new Error('ECONNREFUSED')
      })

      const result = await transcribeWithVLLM({
        audio: audioBuffer,
        mediaType: 'audio/wav',
      })

      expect(result).toBeInstanceOf(TranscriptionError)
      if (result instanceof TranscriptionError) {
        expect(result.message).toContain('vLLM transcription failed')
      }
    })

    test('should handle timeout error on transcription call', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/v1/models')) {
          return { ok: true } as Response
        }
        throw new Error('Connect Timeout Error')
      })

      const result = await transcribeWithVLLM({
        audio: audioBuffer,
        mediaType: 'audio/wav',
      })

      expect(result).toBeInstanceOf(TranscriptionError)
      if (result instanceof TranscriptionError) {
        expect(result.message).toContain('vLLM transcription failed')
      }
    })

    test('should handle malformed JSON response', async () => {
      mockHealthOkAndTranscribe({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON')
        },
      } as unknown as Response)

      const result = await transcribeWithVLLM({
        audio: audioBuffer,
        mediaType: 'audio/wav',
      })

      expect(result).toBeInstanceOf(TranscriptionError)
    })

    test('should return TranscriptionError when vLLM service is not running', async () => {
      // Health check fails
      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/v1/models')) {
          return { ok: false, status: 503 } as Response
        }
        return { ok: true } as Response
      })

      const result = await transcribeWithVLLM({
        audio: audioBuffer,
        mediaType: 'audio/wav',
      })

      expect(result).toBeInstanceOf(TranscriptionError)
      if (result instanceof TranscriptionError) {
        expect(result.message).toContain('vLLM service is not running')
      }
    })
  })
})