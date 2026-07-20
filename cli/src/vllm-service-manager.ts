// vLLM Service Manager - Automatically starts/stops vLLM Whisper service
import { spawn, type ChildProcess } from 'node:child_process'
import { createLogger, LogPrefix } from './logger.js'

const vllmLogger = createLogger(LogPrefix.VLLM)

let vllmProcess: ChildProcess | null = null

// Default vLLM configuration
const DEFAULT_VLLM_PORT = '8766'
const DEFAULT_VLLM_HOST = 'localhost'
const DEFAULT_VLLM_MODEL = 'openai/whisper-large-v3-turbo'

/**
 * Check if the vLLM service is already running.
 */
export async function checkVLLMServiceRunning(
  host: string = process.env.VLLM_HOST || DEFAULT_VLLM_HOST,
  port: string = process.env.VLLM_PORT || DEFAULT_VLLM_PORT,
): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/v1/models`, {
      method: 'GET',
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Get the vLLM base URL for transcription requests.
 */
export function getVLLMBaseUrl(): string {
  const host = process.env.VLLM_HOST || DEFAULT_VLLM_HOST
  const port = process.env.VLLM_PORT || DEFAULT_VLLM_PORT
  return `http://${host}:${port}/v1`
}

/**
 * Check if vLLM CLI is available.
 */
async function checkVLLMCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const checkProcess = spawn('vllm', ['--version'], {
      stdio: 'ignore',
    })
    
    checkProcess.on('error', () => resolve(false))
    checkProcess.on('exit', (code) => resolve(code === 0))
    
    // Timeout after 5 seconds
    setTimeout(() => {
      checkProcess.kill()
      resolve(false)
    }, 5000)
  })
}

/**
 * Start the vLLM Whisper service.
 * Returns true if service started successfully (or already running).
 */
export async function startVLLMService(): Promise<boolean> {
  // Check if already running
  if (await checkVLLMServiceRunning()) {
    vllmLogger.log('vLLM service already running')
    return true
  }

  // Check if vLLM CLI is available
  if (!(await checkVLLMCliAvailable())) {
    vllmLogger.warn(
      'vLLM CLI not found. To enable vLLM Whisper transcription:\n' +
        '  pip install vllm[audio]\n' +
        '  # Or with GPU support:\n' +
        '  pip install vllm[audio]\n' +
        '  vllm serve openai/whisper-large-v3-turbo --port 8766'
    )
    return false
  }

  const host = process.env.VLLM_HOST || DEFAULT_VLLM_HOST
  const port = process.env.VLLM_PORT || DEFAULT_VLLM_PORT
  const model = process.env.VLLM_MODEL || DEFAULT_VLLM_MODEL

  vllmLogger.log(`Starting vLLM service with ${model} on port ${port}...`)

  try {
    // Start vLLM service
    const args = ['serve', model, '--port', port]

    // Add additional args for GPU/MLX optimization
    if (process.env.VLLM_EXTRA_ARGS) {
      args.push(...process.env.VLLM_EXTRA_ARGS.split(' '))
    }

    vllmProcess = spawn('vllm', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        VLLM_HOST: host,
        VLLM_PORT: port,
      },
    })

    // Capture output
    vllmProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim()
      // Only log important vLLM messages
      if (
        output.includes('Uvicorn running') ||
        output.includes('Application startup complete') ||
        output.includes('Loaded model')
      ) {
        vllmLogger.log(`[vLLM] ${output}`)
      }
    })

    vllmProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim()
      // Log errors and warnings
      if (
        output.includes('error') ||
        output.includes('Error') ||
        output.includes('WARNING')
      ) {
        vllmLogger.warn(`[vLLM] ${output}`)
      }
    })

    vllmProcess.on('error', (error) => {
      vllmLogger.error(`vLLM service error: ${error.message}`)
    })

    vllmProcess.on('exit', (code) => {
      vllmLogger.log(`vLLM service exited with code ${code}`)
      vllmProcess = null
    })

    // Wait for service to be ready (max 60 seconds for model loading)
    const maxWaitMs = 60000
    const checkIntervalMs = 1000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, checkIntervalMs))

      if (await checkVLLMServiceRunning(host, port)) {
        vllmLogger.log('vLLM service started successfully')
        return true
      }
    }

    vllmLogger.warn('vLLM service did not become ready in time (60s timeout)')
    return false
  } catch (error) {
    vllmLogger.error(`Failed to start vLLM service: ${error}`)
    return false
  }
}

/**
 * Stop the vLLM service if we started it.
 */
export function stopVLLMService(): void {
  if (vllmProcess) {
    vllmLogger.log('Stopping vLLM service...')
    vllmProcess.kill('SIGTERM')
    vllmProcess = null
  }
}

/**
 * Check if we should auto-start the vLLM service.
 * Auto-starts only if:
 * 1. ASR_PROVIDER is explicitly set to 'vllm'
 * 2. Or VLLM_AUTO_START is set to 'true'
 */
export function shouldAutoStartVLLM(): boolean {
  const provider = process.env.ASR_PROVIDER?.toLowerCase()
  if (provider === 'vllm') {
    return true
  }

  return process.env.VLLM_AUTO_START?.toLowerCase() === 'true'
}

/**
 * Get info about the vLLM service status.
 */
export async function getVLLMInfo(): Promise<{
  running: boolean
  baseUrl: string
  model: string
}> {
  const host = process.env.VLLM_HOST || DEFAULT_VLLM_HOST
  const port = process.env.VLLM_PORT || DEFAULT_VLLM_PORT
  const model = process.env.VLLM_MODEL || DEFAULT_VLLM_MODEL

  return {
    running: await checkVLLMServiceRunning(host, port),
    baseUrl: `http://${host}:${port}/v1`,
    model,
  }
}