// ASR Service Manager - Automatically starts/stops parakeet-mlx service
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { createLogger, LogPrefix } from './logger.js'

const asrLogger = createLogger(LogPrefix.ASR)

let asrProcess: ChildProcess | null = null

/**
 * Get the path to the ASR service directory.
 * Looks for asr-service/ relative to the project root.
 */
function getAsrServicePath(): string | null {
  // Try multiple possible locations
  const possiblePaths = [
    // Running from source (discord/src/)
    path.join(process.cwd(), 'asr-service'),
    // Running from compiled (discord/)
    path.join(process.cwd(), '..', 'asr-service'),
    // Running from npm-linked package
    path.join(__dirname, '..', 'asr-service'),
    // Running from global npm
    path.join(__dirname, '..', '..', 'asr-service'),
  ]

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p
    }
  }

  // Check environment variable
  const envPath = process.env.ASR_SERVICE_PATH
  if (envPath && fs.existsSync(envPath)) {
    return envPath
  }

  return null
}

/**
 * Check if the ASR service is already running.
 */
export async function checkAsrServiceRunning(): Promise<boolean> {
  const port = process.env.ASR_PORT || '8765'
  const host = process.env.ASR_HOST || '127.0.0.1'
  
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      method: 'GET',
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Start the parakeet ASR service.
 * Returns true if service started successfully (or already running).
 */
export async function startAsrService(): Promise<boolean> {
  // Check if already running
  if (await checkAsrServiceRunning()) {
    asrLogger.log('ASR service already running')
    return true
  }

  const servicePath = getAsrServicePath()
  
  if (!servicePath) {
    asrLogger.warn(
      'ASR service directory not found. To enable parakeet ASR:\n' +
      '  1. Ensure asr-service/ folder exists in kimaki project\n' +
      '  2. Or set ASR_SERVICE_PATH environment variable'
    )
    return false
  }

  asrLogger.log(`Starting ASR service from ${servicePath}...`)

  try {
    // Start Python ASR service
    asrProcess = spawn('python3', ['asr_server.py'], {
      cwd: servicePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ASR_PORT: process.env.ASR_PORT || '8765',
        ASR_HOST: process.env.ASR_HOST || '127.0.0.1',
      },
    })

    // Capture output
    asrProcess.stdout?.on('data', (data) => {
      asrLogger.log(`[ASR] ${data.toString().trim()}`)
    })

    asrProcess.stderr?.on('data', (data) => {
      asrLogger.warn(`[ASR] ${data.toString().trim()}`)
    })

    asrProcess.on('error', (error) => {
      asrLogger.error(`ASR service error: ${error.message}`)
    })

    asrProcess.on('exit', (code) => {
      asrLogger.log(`ASR service exited with code ${code}`)
      asrProcess = null
    })

    // Wait for service to be ready (max 30 seconds)
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      
      if (await checkAsrServiceRunning()) {
        asrLogger.log('ASR service started successfully')
        return true
      }
    }

    asrLogger.warn('ASR service did not become ready in time')
    return false

  } catch (error) {
    asrLogger.error(`Failed to start ASR service: ${error}`)
    return false
  }
}

/**
 * Stop the ASR service if we started it.
 */
export function stopAsrService(): void {
  if (asrProcess) {
    asrLogger.log('Stopping ASR service...')
    asrProcess.kill('SIGTERM')
    asrProcess = null
  }
}

/**
 * Check if we should auto-start the ASR service.
 * Only starts if ASR_PROVIDER=parakeet
 */
export function shouldAutoStartAsr(): boolean {
  const provider = process.env.ASR_PROVIDER?.toLowerCase()
  return provider === 'parakeet'
}
