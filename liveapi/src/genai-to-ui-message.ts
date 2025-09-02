import type {
  LiveServerMessage,
  LiveClientMessage,
  LiveServerContent,
  LiveClientContent,
  LiveClientRealtimeInput,
  Content,
  Part,
  FunctionCall,
  FunctionResponse,
  LiveClientToolResponse,
  LiveServerToolCall,
} from '@google/genai'

import type {
  UIMessage,
  UIMessagePart,
  TextUIPart,
  ToolUIPart,
  FileUIPart,
  DataUIPart,
  UIDataTypes,
  UITools,
  UIMessageChunk
} from 'ai'

import { createIdGenerator } from 'ai'

/**
 * Represents a part that can be added to a UI message
 */
export type UIPartUpdate = {
  part: UIMessagePart<UIDataTypes, UITools>
  role: 'system' | 'user' | 'assistant'
  isFinal?: boolean // Indicates if this part completes a turn
}

/**
 * Options for creating a LiveMessageAssembler
 */
export interface LiveMessageAssemblerOptions {
  /**
   * Optional ID generator function. If not provided, uses createIdGenerator from ai package.
   */
  idGenerator?: () => string
}

/**
 * Manages the assembly of websocket messages into UI messages
 */
export class LiveMessageAssembler {
  private currentUserParts: UIMessagePart<UIDataTypes, UITools>[] = []
  private currentAssistantParts: UIMessagePart<UIDataTypes, UITools>[] = []
  private allMessages: UIMessage[] = [] // Store all completed messages
  private idGenerator: () => string

  constructor(options: LiveMessageAssemblerOptions = {}) {
    // Use provided idGenerator or create a default one
    this.idGenerator = options.idGenerator ?? createIdGenerator({
      prefix: 'msg',
      size: 24
    })
  }

  /**
   * Main method to process a server message and return all current UI messages
   * This is the primary interface for using this assembler
   */
  processMessage(message: LiveServerMessage): UIMessage[] {
    // Process the server message to get UI part updates
    const updates = this.processServerMessage(message)

    // Add parts to assembler and get newly completed messages
    const newMessages = this.addParts(updates)

    // Add new messages to our complete history
    if (newMessages.length > 0) {
      this.allMessages.push(...newMessages)
    }

    // Check if we should flush due to interruption
    if (message.serverContent?.interrupted) {
      // Flush any pending parts when interrupted
      const flushedMessages = this.flushPending()
      this.allMessages.push(...flushedMessages)
    }

    // Return all messages including any in-progress parts as temporary messages
    const allMessages = [...this.allMessages]

    // Add temporary messages for any pending parts (not saved to history)
    if (this.currentUserParts.length > 0) {
      allMessages.push(this.createMessage('user', this.currentUserParts))
    }
    if (this.currentAssistantParts.length > 0) {
      allMessages.push(this.createMessage('assistant', this.currentAssistantParts))
    }

    return (allMessages).map(mergeConsecutiveTextParts)
  }

  /**
   * Clear all messages and reset state
   */
  clear(): void {
    this.currentUserParts = []
    this.currentAssistantParts = []
    this.allMessages = []
  }

  /**
   * Get all current messages
   */
  getAllMessages(): UIMessage[] {
    return [...this.allMessages]
  }

  /**
   * Process a server websocket message and extract UI parts
   * @internal - Use processMessage() instead
   */
  processServerMessage(message: LiveServerMessage): UIPartUpdate[] {
    const updates: UIPartUpdate[] = []

    // Handle server content (model responses)
    if (message.serverContent?.modelTurn) {
      const parts = this.extractPartsFromContent(
        message.serverContent.modelTurn,
      )
      for (const part of parts) {
        updates.push({
          part,
          role: 'assistant',
          isFinal: false,
        })
      }

      // Check if turn is complete
      if (message.serverContent.turnComplete) {
        updates.push({
          part: { type: 'text', text: '' } as TextUIPart, // Empty marker
          role: 'assistant',
          isFinal: true,
        })
      }
    }

    // Handle input transcription (user's audio transcription)
    if (message.serverContent?.inputTranscription?.text) {
      updates.push({
        part: {
          type: 'text',
          text: message.serverContent.inputTranscription.text,

        } as TextUIPart,
        role: 'user',
        isFinal: message.serverContent.inputTranscription.finished || false,
      })
    }

    // Handle output transcription (model's audio transcription)
    if (message.serverContent?.outputTranscription?.text) {
      updates.push({
        part: {
          type: 'text',
          text: message.serverContent.outputTranscription.text,

        } as TextUIPart,
        role: 'assistant',
        isFinal: message.serverContent.outputTranscription.finished || false,
      })
    }

    // Handle tool calls
    if (message.toolCall?.functionCalls) {
      for (const functionCall of message.toolCall.functionCalls) {
        updates.push({
          part: this.functionCallToToolPart(functionCall),
          role: 'assistant',
          isFinal: false,
        })
      }
    }

    return updates
  }

  /**
   * Process a client websocket message and extract UI parts
   * @internal - Use processMessage() instead
   */
  processClientMessage(message: LiveClientMessage): UIPartUpdate[] {
    const updates: UIPartUpdate[] = []

    // Handle client content
    if (message.clientContent?.turns) {
      for (const turn of message.clientContent.turns) {
        const role = this.determineRole(turn.role)
        const parts = this.extractPartsFromContent(turn)

        for (const part of parts) {
          updates.push({
            part,
            role,
            isFinal: false,
          })
        }
      }

      // Check if turn is complete
      if (message.clientContent.turnComplete) {
        const lastTurn =
          message.clientContent.turns[message.clientContent.turns.length - 1]
        const role = this.determineRole(lastTurn?.role)
        updates.push({
          part: { type: 'text', text: '' } as TextUIPart, // Empty marker
          role,
          isFinal: true,
        })
      }
    }

    // Handle realtime input (streaming)
    if (message.realtimeInput) {
      const parts = this.processRealtimeInput(message.realtimeInput)
      const isActivityEnd = !!message.realtimeInput.activityEnd
      for (const part of parts) {
        updates.push({
          part,
          role: 'user',
          isFinal: isActivityEnd,
        })
      }
    }

    // Handle tool responses
    if (message.toolResponse?.functionResponses) {
      for (const response of message.toolResponse.functionResponses) {
        updates.push({
          part: this.functionResponseToToolPart(response),
          role: 'user',
          isFinal: false,
        })
      }
    }

    return updates
  }

  /**
   * Add parts to the assembler and get completed messages
   * @internal - Use processMessage() instead
   */
  addParts(updates: UIPartUpdate[]): UIMessage[] {
    const completedMessages: UIMessage[] = []

    for (const update of updates) {
      // Skip empty marker parts
      if (
        update.part.type === 'text' &&
        (update.part).text === '' &&
        update.isFinal
      ) {
        // This is just a turn completion marker
        if (update.role === 'user' && this.currentUserParts.length > 0) {
          completedMessages.push(
            this.createMessage('user', this.currentUserParts),
          )
          this.currentUserParts = []
        } else if (
          update.role === 'assistant' &&
          this.currentAssistantParts.length > 0
        ) {
          completedMessages.push(
            this.createMessage('assistant', this.currentAssistantParts),
          )
          this.currentAssistantParts = []
        }
      } else {
        // Add the actual part
        if (update.role === 'user') {
          this.currentUserParts.push(update.part)
        } else if (update.role === 'assistant') {
          this.currentAssistantParts.push(update.part)
        }

        // Check if turn is complete
        if (update.isFinal) {
          if (update.role === 'user' && this.currentUserParts.length > 0) {
            completedMessages.push(
              this.createMessage('user', this.currentUserParts),
            )
            this.currentUserParts = []
          } else if (
            update.role === 'assistant' &&
            this.currentAssistantParts.length > 0
          ) {
            completedMessages.push(
              this.createMessage('assistant', this.currentAssistantParts),
            )
            this.currentAssistantParts = []
          }
        }
      }
    }

    return completedMessages
  }

  /**
   * Get current incomplete message parts
   * @internal
   */
  getCurrentParts(
    role: 'user' | 'assistant',
  ): UIMessagePart<UIDataTypes, UITools>[] {
    return role === 'user'
      ? [...this.currentUserParts]
      : [...this.currentAssistantParts]
  }

  /**
   * Flush pending parts and return only the newly created messages
   */
  private flushPending(): UIMessage[] {
    const messages: UIMessage[] = []

    if (this.currentUserParts.length > 0) {
      messages.push(this.createMessage('user', this.currentUserParts))
      this.currentUserParts = []
    }

    if (this.currentAssistantParts.length > 0) {
      messages.push(this.createMessage('assistant', this.currentAssistantParts))
      this.currentAssistantParts = []
    }

    return messages
  }

  /**
   * Force flush any pending parts as messages and add them to history
   */
  flush(): UIMessage[] {
    const messages = this.flushPending()

    // Add flushed messages to history
    this.allMessages.push(...messages)

    // Return complete history
    return [...this.allMessages]
  }

  /**
   * Extract UI parts from GenAI Content
   */
  private extractPartsFromContent(
    content: Content,
  ): UIMessagePart<UIDataTypes, UITools>[] {
    if (!content.parts) return []

    return content.parts
      .map((part) => this.convertPartToUIPart(part))
      .filter((p): p is UIMessagePart<UIDataTypes, UITools> => p !== null)
  }

  /**
   * Process realtime input into UI parts
   */
  private processRealtimeInput(
    input: LiveClientRealtimeInput,
  ): UIMessagePart<UIDataTypes, UITools>[] {
    const parts: UIMessagePart<UIDataTypes, UITools>[] = []

    // Handle text streaming
    if (input.text) {
      parts.push({
        type: 'text',
        text: input.text,
        state: input.activityEnd ? 'done' : 'streaming',
      } as TextUIPart)
    }

    // Skip audio chunks - we don't want large data URLs
    // if (input.audio) { ... }

    // Skip video chunks - we don't want large data URLs
    // if (input.video) { ... }

    // Handle media chunks - skip audio/video
    if (input.mediaChunks) {
      for (const chunk of input.mediaChunks) {
        if (chunk && typeof chunk === 'object' && chunk.mimeType) {
          // Skip audio and video chunks
          if (chunk.mimeType?.startsWith('audio/') ||
              chunk.mimeType?.startsWith('video/')) {
            continue
          }

          parts.push({
            type: 'data-url',
            data: {
              mimeType: chunk.mimeType || 'application/octet-stream',
              url: `data:${chunk.mimeType};base64,${chunk.data}`,
            },
          } as DataUIPart<UIDataTypes>)
        }
      }
    }

    return parts
  }

  /**
   * Convert GenAI Part to UI Part
   */
  private convertPartToUIPart(
    part: Part | string,
  ): UIMessagePart<UIDataTypes, UITools> | null {
    // Handle string parts
    if (typeof part === 'string') {
      return {
        type: 'text',
        text: part,
      } as TextUIPart
    }

    // Handle text parts
    if ( part.text) {
      return {
        type: 'text',
        text: part.text,
        providerMetadata: part.thought
          ? { thought: { value: true } }
          : undefined,
      } as TextUIPart
    }

    // Handle inline data - skip audio/video to avoid large data URLs
    if (part.inlineData) {
      // Skip audio and video data
      if (part.inlineData.mimeType?.startsWith('audio/') ||
          part.inlineData.mimeType?.startsWith('video/')) {
        return null
      }

      const mimeType = part.inlineData.mimeType || 'application/octet-stream'
      return {
        type: 'data-url',
        data: {
          mimeType,
          url: `data:${mimeType};base64,${part.inlineData.data}`,
        },
      } as DataUIPart<UIDataTypes>
    }

    // Handle file data
    if (part.fileData) {
      return {
        type: 'file',
        name: part.fileData.fileUri || 'file',
        url: part.fileData.fileUri,
        mediaType: part.fileData.mimeType || 'application/octet-stream',
      } as FileUIPart
    }

    // Handle function calls
    if (part.functionCall) {
      return this.functionCallToToolPart(part.functionCall)
    }

    // Handle function responses
    if (part.functionResponse) {
      return this.functionResponseToToolPart(part.functionResponse)
    }

    // Handle code execution results as tool results
    if (part.codeExecutionResult) {
      return {
        type: 'tool-result',
        toolCallId: this.idGenerator(),
        toolName: 'executableCode',
        state: part.codeExecutionResult.outcome === 'OUTCOME_OK' ? 'output-available' : 'output-error',
        input: {},
        output: part.codeExecutionResult.output || '',
      } as ToolUIPart<UITools>
    }

    // Handle executable code as tool calls
    if (part.executableCode) {
      return {
        type: 'tool-call',
        toolCallId: this.idGenerator(),
        toolName: 'executableCode',
        state: 'input-available',
        input: {
          language: part.executableCode.language || 'unknown',
          code: part.executableCode.code || '',
        },
      } as ToolUIPart<UITools>
    }

    return null
  }

  /**
   * Convert FunctionCall to Tool UI Part
   */
  private functionCallToToolPart(
    functionCall: FunctionCall,
  ): ToolUIPart<UITools> {
    return {
      type: 'tool-call',
      toolCallId: functionCall.id || this.idGenerator(),
      toolName: functionCall.name,
      state: 'input-available',
      input: functionCall.args || {},
      // Omit rawInput to reduce redundancy
    } as ToolUIPart<UITools>
  }

  /**
   * Convert FunctionResponse to Tool UI Part
   */
  private functionResponseToToolPart(
    response: FunctionResponse,
  ): ToolUIPart<UITools> {
    const responseData = response.response || {}
    const isError = responseData.error !== undefined

    if (isError) {
      return {
        type: 'tool-result',
        toolCallId: response.id || this.idGenerator(),
        toolName: response.name,
        state: 'output-error',
        input: {},
        errorText: JSON.stringify(responseData.error),
      } as ToolUIPart<UITools>
    }

    return {
      type: 'tool-result',
      toolCallId: response.id || this.idGenerator(),
      toolName: response.name,
      state: 'output-available',
      input: {},
      output: responseData.output || responseData,
    } as ToolUIPart<UITools>
  }

  /**
   * Create a UIMessage from parts
   */
  private createMessage(
    role: 'system' | 'user' | 'assistant',
    parts: UIMessagePart<UIDataTypes, UITools>[],
  ): UIMessage {
    return {
      id: this.idGenerator(),
      role,
      parts: [...parts], // Create a copy
    }
  }

  /**
   * Determine role from GenAI role string
   */
  private determineRole(role?: string): 'system' | 'user' | 'assistant' {
    if (!role) return 'user'
    if (role === 'model') return 'assistant'
    if (role === 'system' || role === 'user' || role === 'assistant')
      return role
    return 'user'
  }
}


/**
 * Merge consecutive text parts in a UIMessage
 * Uses reduce to combine adjacent text parts into single parts
 */
export function mergeConsecutiveTextParts(message: UIMessage): UIMessage {
  const mergedParts = message.parts.reduce<UIMessagePart<UIDataTypes, UITools>[]>(
    (acc, part) => {
      const lastPart = acc[acc.length - 1]

      // Check if both current and last parts are text parts
      if (
        part.type === 'text' &&
        lastPart?.type === 'text'
      ) {
        // Merge the text content
        const mergedTextPart: TextUIPart = {
          type: 'text',
          text: (lastPart as TextUIPart).text + (part as TextUIPart).text,
        }

        // Preserve state if it exists (use the latest state)
        const currentTextPart = part as TextUIPart
        if (currentTextPart.state) {
          mergedTextPart.state = currentTextPart.state
        } else if ((lastPart as TextUIPart).state) {
          mergedTextPart.state = (lastPart as TextUIPart).state
        }

        // Merge provider metadata if both have it
        const lastTextPart = lastPart as TextUIPart
        if (lastTextPart.providerMetadata || currentTextPart.providerMetadata) {
          mergedTextPart.providerMetadata = {
            ...lastTextPart.providerMetadata,
            ...currentTextPart.providerMetadata,
          }
        }

        // Replace the last part with the merged part
        acc[acc.length - 1] = mergedTextPart
      } else {
        // Not consecutive text parts, just add the current part
        acc.push(part)
      }

      return acc
    },
    []
  )

  return {
    ...message,
    parts: mergedParts,
  }
}

/**
 * Convert UIMessage back to GenAI format (for sending)
 */
export function uiMessageToClientMessage(
  message: UIMessage,
  turnComplete: boolean = true,
): LiveClientMessage {
  // Check if this message contains tool responses
  const toolResponses = message.parts
    .filter((part) => part.type === 'tool-result')
    .map((part) => {
      const toolPart = part as ToolUIPart<UITools>
      return {
        id: toolPart.toolCallId,
        name: '', // Tool name not available in UI part
        response:
          toolPart.state === 'output-error'
            ? { error: toolPart.errorText }
            : toolPart.output || {},
      } as FunctionResponse
    })

  if (toolResponses.length > 0) {
    return {
      toolResponse: {
        functionResponses: toolResponses,
      },
    }
  }

  // Convert to regular content message
  const parts: Part[] = message.parts
    .map((part) => uiPartToGenAIPart(part))
    .filter((p): p is Part => p !== null)

  return {
    clientContent: {
      turns: [
        {
          role: message.role,
          parts,
        },
      ],
      turnComplete,
    },
  }
}

/**
 * Convert UI Part to GenAI Part
 */
function uiPartToGenAIPart(
  part: UIMessagePart<UIDataTypes, UITools>,
): Part | null {
  switch (part.type) {
    case 'text':
      return {
        text: (part as TextUIPart).text,
      } as Part

    case 'file':
      const filePart = part as FileUIPart
      return {
        fileData: {
          fileUri: filePart.url,
          mimeType: filePart.mediaType,
        },
      } as Part

    case 'tool-call':
      const toolCall = part as ToolUIPart<UITools>
      return {
        functionCall: {
          id: toolCall.toolCallId,
          name: '', // Tool name not preserved in UI part
          args: toolCall.input as Record<string, unknown>,
        },
      } as Part

    default:
      // Handle data parts
      if (part.type.startsWith('data-')) {
        const dataPart = part as DataUIPart<UIDataTypes>
        if (
          dataPart.data &&
          typeof dataPart.data === 'object' &&
          'url' in dataPart.data &&
          dataPart.data.url
        ) {
          // Extract base64 data from data URL
          const dataUrl = dataPart.data.url as string
          const base64Match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
          if (base64Match) {
            // Extract mime type from the data URL itself
            const mimeType = base64Match[1] || 'application/octet-stream'
            return {
              inlineData: {
                mimeType: mimeType,
                data: base64Match[2],
              },
            } as Part
          }
        }
      }
      return null
  }
}
