import { describe, expect, test } from 'vitest'
import { splitMarkdownForDiscord } from './discord-utils.js'

describe('splitMarkdownForDiscord', () => {
  test('never returns chunks over the max length with code fences', () => {
    const maxLength = 2000
    const header = '## Summary of Current Architecture\n\n'
    const codeFenceStart = '```\n'
    const codeFenceEnd = '\n```\n'
    const codeLine = 'x'.repeat(180)
    const codeBlock = Array.from({ length: 20 })
      .map(() => codeLine)
      .join('\n')
    const markdown = `${header}${codeFenceStart}${codeBlock}${codeFenceEnd}`

    const chunks = splitMarkdownForDiscord({ content: markdown, maxLength })

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLength)
    }
  })
})
