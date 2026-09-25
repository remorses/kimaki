import { describe, expect, test } from 'vitest'
import type { Message, Part } from '@opencode-ai/sdk/v2'
import { formatContextBreakdown } from './context-usage.js'

const part = (messageID: string, value: Partial<Part>): Part => ({
  id: `part-${messageID}`,
  sessionID: 'session',
  messageID,
  ...value,
} as Part)

const user = (id: string, system?: string): Message => ({
  id, sessionID: 'session', role: 'user', time: { created: 1 },
  agent: 'build', model: { providerID: 'test', modelID: 'test' }, system,
})

const assistant = (id: string, input: number): Message => ({
  id, sessionID: 'session', role: 'assistant', time: { created: 2 },
  parentID: 'user', modelID: 'test', providerID: 'test', mode: 'build',
  agent: 'build', path: { cwd: '/', root: '/' }, cost: 0,
  tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
})

describe('formatContextBreakdown', () => {
  test('attributes tool call inputs and outputs by type, and excludes the response to the measured prompt', () => {
    const messages = [
      { info: user('user', 's'.repeat(40)), parts: [part('user', { type: 'text', text: 'u'.repeat(20) })] },
      { info: assistant('first', 20), parts: [
        part('first', { type: 'tool', tool: 'read', callID: 'call', state: {
          status: 'completed', input: { filePath: 'a'.repeat(28) }, output: 'o'.repeat(40),
          title: 'read', metadata: {}, time: { start: 1, end: 2 },
        } }),
      ] },
      { info: assistant('last', 50), parts: [part('last', { type: 'text', text: 'x'.repeat(800) })] },
    ]

    expect(formatContextBreakdown({ messages, lastAssistantId: 'last', inputTokens: 50 }))
      .toMatchInlineSnapshot(`"**Estimated input mix:** tool read 42.0% (21) · system 20.0% (10) · other 38.0% (19) tokens (other includes messages and unexposed prompts)"`)
  })

  test('ignores compacted history and old tool outputs', () => {
    const messages = [
      { info: user('old', 'x'.repeat(800)), parts: [part('old', { type: 'text', text: 'x'.repeat(800) })] },
      { info: assistant('old-answer', 30), parts: [part('old-answer', { type: 'tool', tool: 'bash', callID: 'old', state: {
        status: 'completed', input: {}, output: 'x'.repeat(800), title: 'old', metadata: {},
        time: { start: 1, end: 2, compacted: 3 },
      } })] },
      { info: user('compact'), parts: [part('compact', { type: 'compaction', auto: true })] },
      { info: assistant('summary', 20), parts: [part('summary', { type: 'text', text: 'summary'.repeat(8) })] },
      { info: user('new', 's'.repeat(20)), parts: [part('new', { type: 'text', text: 'u'.repeat(20) })] },
      { info: assistant('last', 40), parts: [] },
    ]

    expect(formatContextBreakdown({ messages, lastAssistantId: 'last', inputTokens: 40 }))
      .toMatchInlineSnapshot(`"**Estimated input mix:** system 12.5% (5) · other 87.5% (35) tokens (other includes messages and unexposed prompts)"`)
  })
})
