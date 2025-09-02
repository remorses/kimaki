# LiveServerMessage Type Documentation

## Overview
`LiveServerMessage` is the main type for messages sent from the Google GenAI server to the client over WebSocket connection. It represents various types of server responses including model content, tool calls, and metadata.

## Type Structure

```typescript
class LiveServerMessage {
  // Server setup confirmation
  setupComplete?: LiveServerSetupComplete;
  
  // Generated content from the model
  serverContent?: LiveServerContent;
  
  // Tool/function call requests
  toolCall?: LiveServerToolCall;
  
  // Tool call cancellation notifications
  toolCallCancellation?: LiveServerToolCallCancellation;
  
  // Usage statistics and metadata
  usageMetadata?: UsageMetadata;
  
  // Connection termination warning
  goAway?: LiveServerGoAway;
  
  // Session resumption state updates
  sessionResumptionUpdate?: LiveServerSessionResumptionUpdate;
  
  // Computed properties
  get text(): string | undefined;  // Concatenated text parts
  get data(): string | undefined;  // Concatenated inline data parts
}
```

## Key Sub-Types

### LiveServerContent
Contains the model's generated content and transcriptions:

```typescript
interface LiveServerContent {
  // Model's generated content with parts
  modelTurn?: Content;
  
  // Indicates model finished generating current turn
  turnComplete?: boolean;
  
  // Indicates client interrupted generation
  interrupted?: boolean;
  
  // Grounding metadata if enabled
  groundingMetadata?: GroundingMetadata;
  
  // Model finished all generation
  generationComplete?: boolean;
  
  // User's audio input transcription
  inputTranscription?: {
    text: string;
    finished?: boolean;
  };
  
  // Model's audio output transcription
  outputTranscription?: {
    text: string;
    finished?: boolean;
  };
}
```

### Content
The content structure containing parts:

```typescript
interface Content {
  role?: string;  // 'user', 'model', 'system'
  parts: Part[];
}
```

### Part
Individual content parts that can be of various types:

```typescript
interface Part {
  // Text content
  text?: string;
  
  // Inline binary data (audio, images, etc.)
  inlineData?: {
    mimeType: string;
    data: string;  // Base64 encoded
  };
  
  // File reference
  fileData?: {
    fileUri: string;
    mimeType?: string;
  };
  
  // Function call from model
  functionCall?: FunctionCall;
  
  // Function response from client
  functionResponse?: FunctionResponse;
  
  // Code to execute
  executableCode?: {
    language: string;
    code: string;
  };
  
  // Code execution result
  codeExecutionResult?: {
    outcome: string;  // 'OUTCOME_OK', 'OUTCOME_ERROR', etc.
    output?: string;
  };
  
  // Thinking/reasoning indicator
  thought?: boolean;
  
  // Video metadata
  videoMetadata?: VideoMetadata;
}
```

### LiveServerToolCall
Requests the client to execute function calls:

```typescript
interface LiveServerToolCall {
  functionCalls?: FunctionCall[];
}

interface FunctionCall {
  id?: string;           // Unique identifier for tracking
  name?: string;         // Function name to call
  args?: Record<string, unknown>;  // Function arguments
}
```

### FunctionResponse
Response from executed function (appears in Part):

```typescript
class FunctionResponse {
  id?: string;           // Matches FunctionCall.id
  name?: string;         // Function name
  response?: Record<string, unknown>;  // Result or error
  willContinue?: boolean;  // For streaming responses
  scheduling?: FunctionResponseScheduling;
}
```

## Common Message Patterns

### 1. Function Call Request
```json
{
  "toolCall": {
    "functionCalls": [
      {
        "id": "function-call-123",
        "name": "search",
        "args": { "query": "test" }
      }
    ]
  }
}
```

### 2. Function Response (in modelTurn)
```json
{
  "serverContent": {
    "modelTurn": {
      "parts": [
        {
          "functionResponse": {
            "id": "function-call-123",
            "name": "search",
            "response": { "results": ["item1", "item2"] }
          }
        }
      ]
    }
  }
}
```

### 3. Text Generation
```json
{
  "serverContent": {
    "modelTurn": {
      "parts": [
        {
          "text": "Hello, how can I help you?"
        }
      ]
    }
  }
}
```

### 4. Audio Streaming
```json
{
  "serverContent": {
    "modelTurn": {
      "parts": [
        {
          "inlineData": {
            "mimeType": "audio/pcm;rate=24000",
            "data": "[BASE64_ENCODED_AUDIO]"
          }
        }
      ]
    }
  }
}
```

### 5. Transcriptions
```json
{
  "serverContent": {
    "inputTranscription": {
      "text": "User said this",
      "finished": true
    },
    "outputTranscription": {
      "text": "Model is saying this",
      "finished": false
    }
  }
}
```

### 6. Code Execution
```json
{
  "serverContent": {
    "modelTurn": {
      "parts": [
        {
          "executableCode": {
            "language": "PYTHON",
            "code": "print('Hello')"
          }
        },
        {
          "codeExecutionResult": {
            "outcome": "OUTCOME_OK",
            "output": "Hello\n"
          }
        }
      ]
    }
  }
}
```

### 7. Turn Completion
```json
{
  "serverContent": {
    "turnComplete": true
  },
  "usageMetadata": {
    "promptTokenCount": 100,
    "responseTokenCount": 50,
    "totalTokenCount": 150
  }
}
```

## Important Notes

1. **Message Order**: Messages arrive in streaming fashion. Text, audio, and tool calls can be interleaved.

2. **Part Types**: A single `modelTurn` can contain multiple parts of different types (text, audio, function calls, etc.)

3. **Function Flow**: 
   - Server sends `toolCall` with `functionCalls`
   - Client executes and responds
   - Server may include `functionResponse` in subsequent `modelTurn.parts`

4. **Audio Handling**: Audio data comes as base64-encoded PCM in `inlineData` parts

5. **Transcriptions**: `inputTranscription` and `outputTranscription` are independent of model turns and represent real-time speech-to-text

6. **Code Execution**: `executableCode` followed by `codeExecutionResult` represents server-side code execution (different from function calls)