import type { Tool as AITool } from 'ai'

// Messages sent from main thread to worker
export type WorkerInMessage =
  | {
      type: 'init'
      directory: string // Project directory for tools
      systemMessage?: string
      guildId: string
      channelId: string
    }
  | {
      type: 'sendRealtimeInput'
      audio?: {
        mimeType: string
        data: string // base64
      }
      audioStreamEnd?: boolean
    }
  | {
      type: 'sendTextInput'
      text: string
    }
  | {
      type: 'interrupt'
    }
  | {
      type: 'stop'
    }

// Messages sent from worker to main thread via parentPort
export type WorkerOutMessage =
  | {
      type: 'assistantOpusPacket'
      packet: ArrayBuffer // Opus encoded audio packet
    }
  | {
      type: 'assistantStartSpeaking'
    }
  | {
      type: 'assistantStopSpeaking'
    }
  | {
      type: 'assistantInterruptSpeaking'
    }
  | {
      type: 'toolCallCompleted'
      sessionId: string
      messageId: string
      data?: any
      error?: any
      markdown?: string
    }
  | {
      type: 'error'
      error: string
    }
  | {
      type: 'ready'
    }
