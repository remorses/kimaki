import { Worker } from 'node:worker_threads'
import type { WorkerInMessage, WorkerOutMessage } from './worker-types.js'
import type { Tool as AITool } from 'ai'

export interface GenAIWorkerOptions {
  directory: string
  systemMessage?: string
  guildId: string
  channelId: string
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
  sendRealtimeInput(audio: { mimeType: string; data: string }): void
  sendTextInput(text: string): void
  interrupt(): void
  stop(): Promise<void>
}

export function createGenAIWorker(
  options: GenAIWorkerOptions,
): Promise<GenAIWorker> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../dist/genai-worker.js', import.meta.url),
    )

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
          console.error('[GENAI WORKER] Error:', message.error)
          options.onError?.(message.error)
          break
        case 'ready':
          console.log('[GENAI WORKER] Ready')
          // Resolve with the worker interface
          resolve({
            sendRealtimeInput(audio) {
              worker.postMessage({
                type: 'sendRealtimeInput',
                audio,
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
              console.log('[GENAI WORKER WRAPPER] Stopping worker...')
              // Send stop message to trigger graceful shutdown
              worker.postMessage({ type: 'stop' } satisfies WorkerInMessage)

              // Wait for worker to exit gracefully (with timeout)
              await new Promise<void>((resolve) => {
                let resolved = false

                // Listen for worker exit
                worker.once('exit', (code) => {
                  if (!resolved) {
                    resolved = true
                    console.log(
                      `[GENAI WORKER WRAPPER] Worker exited with code ${code}`,
                    )
                    resolve()
                  }
                })

                // Timeout after 5 seconds and force terminate
                setTimeout(() => {
                  if (!resolved) {
                    resolved = true
                    console.log(
                      '[GENAI WORKER WRAPPER] Worker did not exit gracefully, terminating...',
                    )
                    worker.terminate().then(() => {
                      console.log('[GENAI WORKER WRAPPER] Worker terminated')
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
      console.error('[GENAI WORKER] Worker error:', error)
      reject(error)
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[GENAI WORKER] Worker stopped with exit code ${code}`)
      }
    })

    // Send initialization message
    const initMessage: WorkerInMessage = {
      type: 'init',
      directory: options.directory,
      systemMessage: options.systemMessage,
      guildId: options.guildId,
      channelId: options.channelId,
    }
    worker.postMessage(initMessage)
  })
}
