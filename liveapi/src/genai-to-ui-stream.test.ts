import { describe, it, expect } from 'vitest'
import { processLiveServerMessages } from './genai-to-ui-stream.js'
import type { LiveServerMessage } from '@google/genai'
import exampleEvents from './mixtures/example.json' with { type: 'json' }
import { writeFileSync } from 'fs'
import { join } from 'path'

describe('genai-to-ui-stream', () => {
  it('should process example.json events into UIMessageChunks', () => {
    // Cast the example events to LiveServerMessage[]
    const messages = exampleEvents as LiveServerMessage[]
    
    // Process messages to extract UIMessageChunks (only function calls)
    const chunks = processLiveServerMessages(messages)
    
    // Save as snapshot file
    const snapshotPath = join(__dirname, 'snapshots', 'example-ui-chunks.json')
    writeFileSync(snapshotPath, JSON.stringify(chunks, null, 2))
    
    // Verify we extracted the function calls
    expect(chunks).toMatchInlineSnapshot(`
      [
        {
          "input": {
            "code": "
      import React from 'react';

      const Button = () => {
        return (
          <button className="bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 rounded-md">
            Click me
          </button>
        );
      };

      export default Button;
      ",
          },
          "providerExecuted": false,
          "toolCallId": "function-call-3801354532401717052",
          "toolName": "generate_component",
          "type": "tool-input-available",
        },
        {
          "input": {
            "code": "
      import React from 'react';

      const Button = () => {
        return (
          <button className="bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 rounded-md">
            Click me
          </button>
        );
      };

      export default Button;
      ",
          },
          "providerExecuted": false,
          "toolCallId": "function-call-12097728093424691612",
          "toolName": "generate_component",
          "type": "tool-input-available",
        },
      ]
    `)
  })
  
  it('should return empty array when no function calls are present', () => {
    const messagesWithoutFunctionCalls = [
      {
        serverContent: {
          outputTranscription: {
            text: "Hello, how can I help you today?"
          }
        }
      },
      {
        serverContent: {
          modelTurn: {
            parts: [
              {
                text: "This is a text response"
              }
            ]
          }
        }
      }
    ] as any as LiveServerMessage[]
    
    const chunks = processLiveServerMessages(messagesWithoutFunctionCalls)
    
    expect(chunks).toMatchInlineSnapshot(`[]`)
  })
  
  it('should handle messages with multiple function calls', () => {
    const messagesWithMultipleCalls = [
      {
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: "search",
              args: { query: "test" }
            },
            {
              id: "call-2", 
              name: "calculate",
              args: { expression: "2+2" }
            }
          ]
        }
      }
    ] as any as LiveServerMessage[]
    
    const chunks = processLiveServerMessages(messagesWithMultipleCalls)
    
    expect(chunks).toMatchInlineSnapshot(`
      [
        {
          "input": {
            "query": "test",
          },
          "providerExecuted": false,
          "toolCallId": "call-1",
          "toolName": "search",
          "type": "tool-input-available",
        },
        {
          "input": {
            "expression": "2+2",
          },
          "providerExecuted": false,
          "toolCallId": "call-2",
          "toolName": "calculate",
          "type": "tool-input-available",
        },
      ]
    `)
  })

  it('should handle function call outputs', () => {
    const messagesWithOutputs = [
      {
        serverContent: {
          modelTurn: {
            parts: [
              {
                codeExecutionResult: {
                  outcome: "OUTCOME_OK",
                  output: "{'output': {'success': True}}\n"
                }
              }
            ]
          }
        }
      }
    ] as any as LiveServerMessage[]
    
    const chunks = processLiveServerMessages(messagesWithOutputs)
    
    expect(chunks).toMatchInlineSnapshot(`[]`)
  })
})