import type { QueueConfig } from './config.js'

export type MessageSendAction = 'queue' | 'interrupt-and-consume'

export function getMessageSendAction({
  queueConfig,
  messageContent,
  hasActiveRequest,
}: {
  queueConfig: QueueConfig
  messageContent: string
  hasActiveRequest: boolean
}): MessageSendAction | undefined {
  const interruptOverride = queueConfig.interruptOverride?.trim()
  if (interruptOverride && messageContent.trim() === interruptOverride) {
    return 'interrupt-and-consume'
  }

  if (hasActiveRequest && queueConfig.mode === 'queue') {
    return 'queue'
  }
}
