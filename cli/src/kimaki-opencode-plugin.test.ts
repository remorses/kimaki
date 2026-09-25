import { test, expect, describe } from 'vitest'
import { condenseMemoryMd } from './condense-memory.js'

describe('condenseMemoryMd', () => {
  test('multiple headings with body content', () => {
    const content = [
      '# Project Overview',
      '',
      'This is a big project with many things.',
      'It does X, Y, and Z.',
      '',
      '## Auth Architecture',
      '',
      'JWT tokens with 15min expiry.',
      'Refresh tokens in httpOnly cookies.',
      'Session stored in Redis.',
      '',
      '## User Preferences',
      '',
      '- kebab-case filenames',
      '- errore-style errors',
      '- no emojis',
      '',
      '### API Conventions',
      '',
      'All routes return { data, error }.',
      'Use spiceflow for the server.',
      '',
    ].join('\n')

    expect(condenseMemoryMd(content)).toMatchInlineSnapshot(`
      "1: # Project Overview
      ...
      6: ## Auth Architecture
      ...
      12: ## User Preferences
      ...
      18: ### API Conventions
      ..."
    `)
  })

  test('body text before first heading', () => {
    const content = [
      'Some preamble notes.',
      '',
      '# First Heading',
      '',
      'Content here.',
      '',
    ].join('\n')

    expect(condenseMemoryMd(content)).toMatchInlineSnapshot(`
      "...
      3: # First Heading
      ..."
    `)
  })

  test('no headings at all', () => {
    const content = 'Just some notes.\nMore notes.\n'
    expect(condenseMemoryMd(content)).toMatchInlineSnapshot(`"..."`)
  })

  test('empty content', () => {
    expect(condenseMemoryMd('')).toMatchInlineSnapshot(`""`)
  })

  test('consecutive headings without body', () => {
    const content = [
      '# H1',
      '## H2',
      '### H3',
      '',
      'Some body.',
      '',
    ].join('\n')

    expect(condenseMemoryMd(content)).toMatchInlineSnapshot(`
      "1: # H1
      2: ## H2
      3: ### H3
      ..."
    `)
  })

  test('heading with code block body', () => {
    const content = [
      '# Config',
      '',
      '```json',
      '{ "key": "value" }',
      '```',
      '',
      '## Notes',
      '',
      'Some text.',
      '',
    ].join('\n')

    expect(condenseMemoryMd(content)).toMatchInlineSnapshot(`
      "1: # Config
      ...
      7: ## Notes
      ..."
    `)
  })
})
