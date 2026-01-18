// Main thread interface for the GenAI worker.
// Spawns and manages the worker thread, handling message passing for
// audio input/output, tool call completions, and graceful shutdown.

import { Worker } from 'node:worker_threads'
import type { WorkerInMessage, WorkerOutMessage } from './worker-types.js'
import type { Tool as AITool } from 'ai'
import { createLogger } from './logger.js'

const genaiWorkerLogger = createLogger('GENAI WORKER')
const genaiWrapperLogger = createLogger('GENAI WORKER WRAPPER')

export interface GenAIWorkerOptions {
  directory: string
  systemMessage?: string
  guildId: string
  channelId: string
  appId: string
  geminiApiKey?: string | null
  onAssistantOpusPacket: (packet: ArrayBuffer) => void
  onAssistantStartSpeaking?: () => void
  onAssistantStopSpeaking?: () => void
  onAssistantInterruptSpeaking?: () => void
  onToolCallCompleted?: (params: {
    sessionId: string
    messageId: string
    data?: any
    error?: any
    markdown?: string
  }) => void
  onError?: (error: string) => void
}

export interface GenAIWorker {
  sendRealtimeInput(params: {
    audio?: { mimeType: string; data: string }
    audioStreamEnd?: boolean
  }): void
  sendTextInput(text: string): void
  interrupt(): void
  stop(): Promise<void>
}

export function createGenAIWorker(options: GenAIWorkerOptions): Promise<GenAIWorker> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../dist/genai-worker.js', import.meta.url))

    // Handle messages from worker
    worker.on('message', (message: WorkerOutMessage) => {
      switch (message.type) {
        case 'assistantOpusPacket':
          options.onAssistantOpusPacket(message.packet)
          break
        case 'assistantStartSpeaking':
          options.onAssistantStartSpeaking?.()
          break
        case 'assistantStopSpeaking':
          options.onAssistantStopSpeaking?.()
          break
        case 'assistantInterruptSpeaking':
          options.onAssistantInterruptSpeaking?.()
          break
        case 'toolCallCompleted':
          options.onToolCallCompleted?.(message)
          break
        case 'error':
          genaiWorkerLogger.error('Error:', message.error)
          options.onError?.(message.error)
          break
        case 'ready':
          genaiWorkerLogger.log('Ready')
          // Resolve with the worker interface
          resolve({
            sendRealtimeInput({ audio, audioStreamEnd }) {
              worker.postMessage({
                type: 'sendRealtimeInput',
                audio,
                audioStreamEnd,
              } satisfies WorkerInMessage)
            },
            sendTextInput(text) {
              worker.postMessage({
                type: 'sendTextInput',
                text,
              } satisfies WorkerInMessage)
            },
            interrupt() {
              worker.postMessage({
                type: 'interrupt',
              } satisfies WorkerInMessage)
            },
            async stop() {
              genaiWrapperLogger.log('Stopping worker...')
              // Send stop message to trigger graceful shutdown
              worker.postMessage({ type: 'stop' } satisfies WorkerInMessage)

              // Wait for worker to exit gracefully (with timeout)
              await new Promise<void>((resolve) => {
                let resolved = false

                // Listen for worker exit
                worker.once('exit', (code) => {
                  if (!resolved) {
                    resolved = true
                    genaiWrapperLogger.log(`[GENAI WORKER WRAPPER] Worker exited with code ${code}`)
                    resolve()
                  }
                })

                // Timeout after 5 seconds and force terminate
                setTimeout(() => {
                  if (!resolved) {
                    resolved = true
                    genaiWrapperLogger.log(
                      '[GENAI WORKER WRAPPER] Worker did not exit gracefully, terminating...',
                    )
                    worker.terminate().then(() => {
                      genaiWrapperLogger.log('Worker terminated')
                      resolve()
                    })
                  }
                }, 5000)
              })
            },
          })
          break
      }
    })

    // Handle worker errors
    worker.on('error', (error) => {
      genaiWorkerLogger.error('Worker error:', error)
      reject(error)
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        genaiWorkerLogger.error(`Worker stopped with exit code ${code}`)
      }
    })

    // Send initialization message
    const initMessage: WorkerInMessage = {
      type: 'init',
      directory: options.directory,
      systemMessage: options.systemMessage,
      guildId: options.guildId,
      channelId: options.channelId,
      appId: options.appId,
      geminiApiKey: options.geminiApiKey,
    }
    worker.postMessage(initMessage)
  })
}
