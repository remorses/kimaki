import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  checkVLLMServiceRunning,
  getVLLMBaseUrl,
  shouldAutoStartVLLM,
  getVLLMInfo,
} from './vllm-service-manager.js'

// Mock child_process
const mockSpawn = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

describe('vLLM Service Manager', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Reset env vars
    delete process.env.VLLM_HOST
    delete process.env.VLLM_PORT
    delete process.env.VLLM_MODEL
    delete process.env.VLLM_AUTO_START
    delete process.env.ASR_PROVIDER
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getVLLMBaseUrl', () => {
    test('should return default URL when no env vars set', () => {
      expect(getVLLMBaseUrl()).toBe('http://localhost:8766/v1')
    })

    test('should use custom host from env', () => {
      process.env.VLLM_HOST = 'custom-host'
      expect(getVLLMBaseUrl()).toBe('http://custom-host:8766/v1')
    })

    test('should use custom port from env', () => {
      process.env.VLLM_PORT = '9999'
      expect(getVLLMBaseUrl()).toBe('http://localhost:9999/v1')
    })

    test('should use both custom host and port', () => {
      process.env.VLLM_HOST = '192.168.1.100'
      process.env.VLLM_PORT = '8080'
      expect(getVLLMBaseUrl()).toBe('http://192.168.1.100:8080/v1')
    })
  })

  describe('shouldAutoStartVLLM', () => {
    test('should return false when no env vars set', () => {
      expect(shouldAutoStartVLLM()).toBe(false)
    })

    test('should return true when VLLM_AUTO_START=true', () => {
      process.env.VLLM_AUTO_START = 'true'
      expect(shouldAutoStartVLLM()).toBe(true)
    })

    test('should return true when ASR_PROVIDER=vllm', () => {
      process.env.ASR_PROVIDER = 'vllm'
      expect(shouldAutoStartVLLM()).toBe(true)
    })

    test('should return true when ASR_PROVIDER=VLLM (case insensitive)', () => {
      process.env.ASR_PROVIDER = 'VLLM'
      expect(shouldAutoStartVLLM()).toBe(true)
    })

    test('should return false when VLLM_AUTO_START=false', () => {
      process.env.VLLM_AUTO_START = 'false'
      expect(shouldAutoStartVLLM()).toBe(false)
    })
  })

  describe('checkVLLMServiceRunning', () => {
    test('should return true when service responds ok', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true })
      global.fetch = mockFetch as unknown as typeof fetch

      const result = await checkVLLMServiceRunning()
      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/models'),
        expect.objectContaining({ method: 'GET' })
      )
    })

    test('should return false when service returns error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false })
      global.fetch = mockFetch as unknown as typeof fetch

      const result = await checkVLLMServiceRunning()
      expect(result).toBe(false)
    })

    test('should return false when service is unreachable', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      global.fetch = mockFetch as unknown as typeof fetch

      const result = await checkVLLMServiceRunning()
      expect(result).toBe(false)
    })

    test('should use custom host and port', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true })
      global.fetch = mockFetch as unknown as typeof fetch

      const result = await checkVLLMServiceRunning('custom-host', '9999')
      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('http://custom-host:9999/v1/models'),
        expect.any(Object)
      )
    })
  })

  describe('getVLLMInfo', () => {
    test('should return correct info with defaults', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true })
      global.fetch = mockFetch as unknown as typeof fetch

      const info = await getVLLMInfo()
      expect(info).toEqual({
        running: true,
        baseUrl: 'http://localhost:8766/v1',
        model: 'openai/whisper-large-v3-turbo',
      })
    })

    test('should return correct info with custom settings', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false })
      global.fetch = mockFetch as unknown as typeof fetch

      process.env.VLLM_HOST = 'gpu-server'
      process.env.VLLM_PORT = '8888'
      process.env.VLLM_MODEL = 'openai/whisper-large-v3'

      const info = await getVLLMInfo()
      expect(info).toEqual({
        running: false,
        baseUrl: 'http://gpu-server:8888/v1',
        model: 'openai/whisper-large-v3',
      })
    })
  })
})