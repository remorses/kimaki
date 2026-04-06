import { describe, expect, test } from 'vitest'
import { parseInlineHtmlRenderables } from './html-components.js'

describe('parseInlineHtmlRenderables', () => {
  test('parses text and button fragments', () => {
    const result = parseInlineHtmlRenderables({
      html: 'Before <button id="delete-a" variant="danger">Delete</button> after',
    })
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "text": "Before ",
          "type": "text",
        },
        {
          "disabled": false,
          "id": "delete-a",
          "label": "Delete",
          "type": "button",
          "variant": "danger",
        },
        {
          "text": " after",
          "type": "text",
        },
      ]
    `)
  })

  test('rejects buttons without id', () => {
    const result = parseInlineHtmlRenderables({
      html: '<button>Delete</button>',
    })
    expect(result instanceof Error ? result.message : result).toBe(
      '<button> is missing required id attribute',
    )
  })
})
