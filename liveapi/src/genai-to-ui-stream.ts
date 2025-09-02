import type { LiveServerMessage } from '@google/genai'
import type { UIMessageChunk } from 'ai'
import { createIdGenerator } from 'ai'

/**
 * Convert a LiveServerMessage to UIMessageChunks, handling function calls and their responses
 */
export function liveServerMessageToUIMessageChunks(
  message: LiveServerMessage,
  idGenerator: () => string = createIdGenerator({ prefix: 'msg', size: 24 }),
): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = []

  // Handle tool calls (function calls)
  if (message.toolCall?.functionCalls) {
    for (const functionCall of message.toolCall.functionCalls) {
      chunks.push({
        type: 'tool-input-available',
        toolCallId: functionCall.id || idGenerator(),
        toolName: functionCall.name || 'unknown',
        input: functionCall.args || {},

        providerExecuted: false,
      })
    }
  }

  // Handle server content with function responses (function outputs)
  if (message.serverContent?.modelTurn?.parts) {
    for (const part of message.serverContent.modelTurn.parts) {
      // Handle function responses as tool outputs
      if (part.functionResponse) {
        chunks.push({
          type: 'tool-output-available',

          toolCallId: part.functionResponse.id || idGenerator(),
          output: part.functionResponse.response || '',
          providerExecuted: false,
        })
      }
    }
  }

  return chunks
}

/**
 * Process an array of LiveServerMessages and extract UIMessageChunks for function calls
 */
export function processLiveServerMessages(
  messages: LiveServerMessage[],
  idGenerator?: () => string,
): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = []

  for (const message of messages) {
    const messageChunks = liveServerMessageToUIMessageChunks(
      message,
      idGenerator,
    )
    chunks.push(...messageChunks)
  }

  return chunks
}
