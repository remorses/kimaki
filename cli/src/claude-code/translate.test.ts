import { describe, expect, test } from 'vitest'
import {
  buildQuestionAnswersInput,
  buildUserContent,
  extractToolResults,
  mapAskUserQuestions,
  normalizeToolName,
  stringifyToolResultContent,
  translateAssistantBlock,
  translateTranscriptMessages,
} from './translate.js'

describe('buildUserContent', () => {
  test('text and data-url image parts become content blocks', () => {
    const pngData = Buffer.from('fakepng').toString('base64')
    const content = buildUserContent({
      parts: [
        { type: 'text', text: 'look at this' },
        {
          type: 'file',
          mime: 'image/png',
          filename: 'shot.png',
          url: `data:image/png;base64,${pngData}`,
        },
      ],
    })
    expect(content).toEqual([
      { type: 'text', text: 'look at this' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: pngData },
      },
    ])
  })

  test('pdf becomes a document block', () => {
    const pdfData = Buffer.from('fakepdf').toString('base64')
    const content = buildUserContent({
      parts: [
        {
          type: 'file',
          mime: 'application/pdf',
          url: `data:application/pdf;base64,${pdfData}`,
        },
      ],
    })
    expect(content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: pdfData },
      },
    ])
  })

  test('empty text parts are skipped', () => {
    expect(buildUserContent({ parts: [{ type: 'text', text: '   ' }] })).toEqual([])
  })
})

describe('tool results', () => {
  test('extractToolResults reads tool_result blocks', () => {
    const results = extractToolResults({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: 'file contents' }],
        },
      ],
    })
    expect(results).toEqual([{ toolUseId: 'toolu_1', output: 'file contents', isError: false }])
  })

  test('stringifyToolResultContent handles strings, arrays and objects', () => {
    expect(stringifyToolResultContent('plain')).toBe('plain')
    expect(
      stringifyToolResultContent([
        { type: 'text', text: 'a' },
        { type: 'image', source: {} },
      ]),
    ).toBe('a\n[image]')
    expect(stringifyToolResultContent({ some: 'json' })).toBe('{"some":"json"}')
  })
})

describe('mapAskUserQuestions / buildQuestionAnswersInput', () => {
  const input = {
    questions: [
      {
        question: 'Which database should we use?',
        header: 'Database',
        multiSelect: false,
        options: [
          { label: 'Postgres', description: 'Relational' },
          { label: 'SQLite', description: 'Embedded' },
        ],
      },
    ],
  }

  test('maps AskUserQuestion input onto OpenCode QuestionInfo', () => {
    const questions = mapAskUserQuestions(input)
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({
      question: 'Which database should we use?',
      header: 'Database',
      multiple: false,
      options: [
        { label: 'Postgres', description: 'Relational' },
        { label: 'SQLite', description: 'Embedded' },
      ],
    })
  })

  test('builds updatedInput with answers keyed by question text', () => {
    const questions = mapAskUserQuestions(input)
    const updated = buildQuestionAnswersInput({
      originalInput: input,
      questions,
      answers: [['Postgres']],
    })
    expect(updated).toEqual({
      questions: input.questions,
      answers: { 'Which database should we use?': 'Postgres' },
    })
  })

  test('multi-select answers stay arrays', () => {
    const multiInput = {
      questions: [
        {
          question: 'Which features?',
          header: 'Features',
          multiSelect: true,
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
        },
      ],
    }
    const questions = mapAskUserQuestions(multiInput)
    const updated = buildQuestionAnswersInput({
      originalInput: multiInput,
      questions,
      answers: [['A', 'B']],
    })
    expect(updated).toMatchObject({
      answers: { 'Which features?': ['A', 'B'] },
    })
  })
})

describe('normalizeToolName', () => {
  test('maps Claude tool names to opencode-style lowercase names', () => {
    expect(normalizeToolName('Bash')).toBe('bash')
    expect(normalizeToolName('MultiEdit')).toBe('edit')
    expect(normalizeToolName('Task')).toBe('task')
    expect(normalizeToolName('WebFetch')).toBe('webfetch')
    expect(normalizeToolName('mcp__kimaki__kimaki_action_buttons')).toBe('kimaki_action_buttons')
    expect(normalizeToolName('SomethingNew')).toBe('somethingnew')
  })
})

describe('translateAssistantBlock', () => {
  test('text block becomes a text part', () => {
    const part = translateAssistantBlock({
      block: { type: 'text', text: 'hello', citations: null },
      sessionId: 'ses_claude_x',
      messageId: 'msg_claude_x',
      now: 123,
    })
    expect(part).toMatchObject({ type: 'text', text: 'hello' })
  })

  test('tool_use block becomes a running tool part', () => {
    const part = translateAssistantBlock({
      block: {
        type: 'tool_use',
        id: 'toolu_9',
        name: 'Bash',
        input: { command: 'ls' },
      },
      sessionId: 'ses_claude_x',
      messageId: 'msg_claude_x',
      now: 123,
    })
    expect(part).toMatchObject({
      type: 'tool',
      callID: 'toolu_9',
      tool: 'bash',
      state: { status: 'running', input: { command: 'ls' } },
    })
  })
})

describe('translateTranscriptMessages', () => {
  test('rebuilds user/assistant messages and resolves tool results', () => {
    const { messages } = translateTranscriptMessages({
      transcript: [
        {
          type: 'user',
          uuid: 'u1',
          parent_tool_use_id: null,
          message: { role: 'user', content: 'run ls please' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [
              { type: 'text', text: 'Running it now' },
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'u2',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md' }],
          },
        },
      ],
      sessionId: 'ses_claude_t',
      directory: '/repo',
      agent: 'claude',
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]!.info.role).toBe('user')
    expect(messages[1]!.info.role).toBe('assistant')
    const toolPart = messages[1]!.parts.find((part) => {
      return part.type === 'tool'
    })
    expect(toolPart).toMatchObject({
      type: 'tool',
      state: { status: 'completed', output: 'README.md' },
    })
  })
})
