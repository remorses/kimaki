import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { transcribeWithVLLM, checkVLLMService } from './voice.js'
import { TranscriptionError } from './errors.js'

describe('vLLM Transcription', () => {
  // Mock fetch
  const mockFetch = vi.fn()

  beforeEach(() => {
    mockFetch.mockReset()
    global.fetch = mockFetch as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('checkVLLMService', () => {
    test('should return true when vLLM service is healthy', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
      } as Response)

      const result = await checkVLLMService()
      expect(result).toBe(true)
    })

    test('should return false when vLLM service returns error status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as Response)

      const result = await checkVLLMService()
      expect(result).toBe(false)
    })

    test('should return false when vLLM service is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const result = await checkVLLMService()
      expect(result).toBe(false)
    })
  })

  describe('transcribeWithVLLM', () => {
    const audioBuffer = Buffer.from('fake audio data')
    const validVLLMResponse = {
      text: 'Hello, this is a test transcription',
      duration: 2.5,
      language: 'en',
    }

    test('should transcribe audio successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => validVLLMResponse,
      } as Response)

      const result = await transcribeWithVLLM({
        audioBuffer,
        mediaType: 'audio/wav',
      })

      // Check it's not an error (success case)
      expect(result).not.toBeInstanceOf(Error)
      if ('transcription' in result) {
        expect(result.transcription).toBe('Hello, this is a test transcription')
        expect(result.queueMessage).toBe(false)
      }

      // Verify fetch was called with correct parameters
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/audio/transcriptions'),
        expect.objectContaining({ method: 'POST' })
      )
    })

    test('should handle OGG audio format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...validVLLMResponse, text: 'OGG transcription' }),
      } as Response)

      const result = await transcribeWithVLLM({
        audioBuffer,
        mediaType: 'audio/ogg',
      })

      expect(result).not.toBeInstanceOf(Error)
      if ('transcription' in result) {
        expect(result.transcription).toBe('OGG transcription')
      }
    })

    test('should return TranscriptionError when service returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      } as Response)

      const result = await transcribeWithVLLM({
        audioBuffer,
        mediaType: 'audio/wav',
      })

      expect(result).toBeInstanceOf(TranscriptionError)
      if (result instanceof TranscriptionError) {
        expect(result.message).toContain('vLLM service error')
      }
    })

    test('should return TranscriptionError when transcription is empty', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: '' }),
      } as Response)

      const result = await transcribeWithVLLM({
        audioBuffer,
        mediaType: 'audio/wav',
      })

      expect(result).toBeInstanceOf(TranscriptionError)
      if (result instanceof TranscriptionError) {
        expect(result.message).toContain('empty transcription')
      }
    })

    test('should handle connection refused error', async () => {
      const error = new Error('ECONNREFUSED')
      mockFetch.mockRejectedValueOnce(error)

      const result = await transcribeWithVLLM({
        audioBuffer,
        mediaType: 'audio/wav',
      })

      expect(result).toBeInstanceOf(TranscriptionError)
      if (result instanceof TranscriptionError) {
        expect(result.message).toContain('vLLM service is not running')
      }
    })

    test('should handle timeout error', async () => {
      const error = new Error('Connect Timeout Error')
      mockFetch.mockRejectedValueOnce(error)

      const result = await transcribeWithVLLM({
        audioBuffer,
        mediaType: 'audio/wav',
      })

      expect(result).toBeInstanceOf(TranscriptionError)
      if (result instanceof TranscriptionError) {
        expect(result.message).toContain('connection timeout')
      }
    })

    test('should handle malformed JSON response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON')
        },
      } as unknown as Response)

      const result = await transcribeWithVLLM({
        audioBuffer,
        mediaType: 'audio/wav',
      })

      expect(result).toBeInstanceOf(TranscriptionError)
    })
  })
})