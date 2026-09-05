import { describe, expect, test } from 'vitest'
import { parseModelShortcuts } from './model-shortcuts.js'

describe('parseModelShortcuts', () => {
  test('parses model shortcuts with and without variants', () => {
    expect(
      parseModelShortcuts([
        'glm=zai-coding-plan/glm-5.3,max,low,high,max',
        'luna=openai/gpt-5.6-luna',
      ]),
    ).toEqual([
      {
        name: 'glm',
        model: 'zai-coding-plan/glm-5.3',
        defaultVariant: 'max',
        variants: ['low', 'high', 'max'],
      },
      { name: 'luna', model: 'openai/gpt-5.6-luna', variants: [] },
    ])
  })

  test.each([
    ['missing separator', 'glm'],
    ['invalid command name', 'GLM=zai/glm-5.3'],
    ['missing provider', 'glm=glm-5.3'],
    ['empty variant', 'glm=zai/glm-5.3,'],
    ['reserved suffix', 'glm-agent=zai/glm-5.3'],
    ['default absent from choices', 'glm=zai/glm-5.3,max,low,high'],
    ['duplicate choices', 'glm=zai/glm-5.3,high,low,high,high'],
    ['oversized default', `glm=zai/glm-5.3,${'x'.repeat(101)}`],
    ['oversized choice', `glm=zai/glm-5.3,high,${'x'.repeat(101)}`],
  ])('rejects %s', (_label, value) => {
    expect(parseModelShortcuts([value])).toBeInstanceOf(Error)
  })

  test('rejects duplicate command names', () => {
    expect(parseModelShortcuts(['glm=zai/glm-5.3', 'glm=zai/glm-5.3-flash'])).toBeInstanceOf(Error)
  })
})
