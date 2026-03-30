// Tests for deterministic provider matcher selection and tool-call output.

import { describe, expect, test } from 'vitest'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { createDeterministicProvider } from './deterministic-provider.js'

describe('createDeterministicProvider', () => {
  test('emits v3 tool call for matched sleep prompt', async () => {
    const provider = createDeterministicProvider({
      strict: true,
      matchers: [
        {
          id: 'sleep',
          when: {
            lastMessageRole: 'user',
            latestUserTextIncludes: 'sleep 500',
          },
          then: {
            parts: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'sleep-call-1',
                toolName: 'bash',
                input: JSON.stringify({ command: 'sleep 500' }),
              },
              {
                type: 'finish',
                finishReason: 'tool-calls',
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              },
            ],
          },
        },
      ],
    })

    const model = provider.languageModel('deterministic-v2')
    expect(model.specificationVersion).toBe('v3')
    const result = await model.doStream({
      prompt: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'please run sleep 500 now' }],
        },
      ],
    })

    const parts = await collectParts({ stream: result.stream })
    const toolCall = parts.find((part) => {
      return part.type === 'tool-call'
    })

    expect(toolCall).toBeDefined()
    if (toolCall && toolCall.type === 'tool-call') {
      expect(toolCall.toolName).toBe('bash')
      expect(toolCall.input).toContain('sleep 500')
    }
  })

  test('throws for unmatched prompt in strict mode', async () => {
    const provider = createDeterministicProvider({
      strict: true,
      matchers: [],
    })

    const model = provider.languageModel('deterministic-v2')
    await expect(
      model.doGenerate({
        prompt: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'no matcher' }],
          },
        ],
      }),
    ).rejects.toThrow('No deterministic matcher matched current prompt')
  })
})

async function collectParts({
  stream,
}: {
  stream: ReadableStream<LanguageModelV3StreamPart>
}) {
  const reader = stream.getReader()
  const parts: LanguageModelV3StreamPart[] = []
  while (true) {
    const next = await reader.read()
    if (next.done) {
      return parts
    }
    parts.push(next.value)
  }
}
