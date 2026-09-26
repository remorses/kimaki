import { describe, expect, test } from 'vitest'
import type { SessionMessageInfo } from '@opencode/client'
import { formatContextBreakdown } from './context-usage.js'

type AssistantContent = Extract<SessionMessageInfo, { type: 'assistant' }>['content']

const user = (id: string, text: string): SessionMessageInfo => ({
  id, type: 'user', time: { created: 1 }, text,
})

const assistant = ({ id, input, content }: {
  id: string
  input: number
  content: AssistantContent
}): SessionMessageInfo => ({
  id, type: 'assistant', time: { created: 2 }, agent: 'build',
  model: { providerID: 'test', id: 'test' }, content, cost: 0,
  tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
})

const tool = ({ name, input, output }: {
  name: string
  input: Record<string, string>
  output: string
}): AssistantContent[number] => ({
  type: 'tool', id: `call-${name}`, name, time: { created: 1 },
  state: { status: 'completed', input, content: [{ type: 'text', text: output }] },
})

describe('formatContextBreakdown', () => {
  test('attributes tool call inputs and outputs by type, and excludes the response to the measured prompt', () => {
    const messages = [
      user('user', 'u'.repeat(20)),
      assistant({
        id: 'first',
        input: 20,
        content: [tool({ name: 'read', input: { path: 'a'.repeat(32) }, output: 'o'.repeat(40) })],
      }),
      assistant({ id: 'last', input: 50, content: [{ type: 'text', text: 'x'.repeat(800) }] }),
    ]

    expect(formatContextBreakdown({ messages, lastAssistantId: 'last', inputTokens: 50, systemChars: 40 }))
      .toMatchInlineSnapshot(`"**Estimated input mix:** tool read 42.0% (21) · system 20.0% (10) · other 38.0% (19) tokens (other includes messages and unexposed prompts)"`)
  })

  test('ignores compacted history', () => {
    const messages: SessionMessageInfo[] = [
      user('old', 'x'.repeat(800)),
      assistant({
        id: 'old-answer',
        input: 30,
        content: [tool({ name: 'shell', input: {}, output: 'x'.repeat(800) })],
      }),
      {
        type: 'compaction', id: 'compact', time: { created: 3 }, status: 'completed',
        reason: 'auto', summary: 'summary'.repeat(8), recent: 'new',
      },
      user('new', 'u'.repeat(20)),
      assistant({ id: 'last', input: 40, content: [] }),
    ]

    expect(formatContextBreakdown({ messages, lastAssistantId: 'last', inputTokens: 40, systemChars: 20 }))
      .toMatchInlineSnapshot(`"**Estimated input mix:** system 12.5% (5) · other 87.5% (35) tokens (other includes messages and unexposed prompts)"`)
  })
})
