import { describe, test, expect } from 'vitest'
import { extractNonXmlContent } from './xml.js'

describe('extractNonXmlContent', () => {
  test('removes xml tags and returns only text content', () => {
    const xml = 'Hello <tag>content</tag> world <nested><inner>deep</inner></nested> end'
    expect(extractNonXmlContent(xml)).toMatchInlineSnapshot(`
      "Hello
      world
      end"
    `)
  })

  test('handles multiple text segments', () => {
    const xml = 'Start <a>tag1</a> middle <b>tag2</b> finish'
    expect(extractNonXmlContent(xml)).toMatchInlineSnapshot(`
      "Start
      middle
      finish"
    `)
  })

  test('handles only xml without text', () => {
    const xml = '<root><child>content</child></root>'
    expect(extractNonXmlContent(xml)).toMatchInlineSnapshot(`""`)
  })

  test('handles only text without xml', () => {
    const xml = 'Just plain text'
    expect(extractNonXmlContent(xml)).toMatchInlineSnapshot(`"Just plain text"`)
  })

  test('handles empty string', () => {
    const xml = ''
    expect(extractNonXmlContent(xml)).toMatchInlineSnapshot(`""`)
  })
})
