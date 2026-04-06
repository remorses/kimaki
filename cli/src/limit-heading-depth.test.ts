import { expect, test } from 'vitest'
import { limitHeadingDepth } from './limit-heading-depth.js'

test('converts h4 to h3', () => {
  const input = '#### Fourth level heading'
  const result = limitHeadingDepth(input)
  expect(result).toMatchInlineSnapshot(`
    "### Fourth level heading
    "
  `)
})

test('converts h5 to h3', () => {
  const input = '##### Fifth level heading'
  const result = limitHeadingDepth(input)
  expect(result).toMatchInlineSnapshot(`
    "### Fifth level heading
    "
  `)
})

test('converts h6 to h3', () => {
  const input = '###### Sixth level heading'
  const result = limitHeadingDepth(input)
  expect(result).toMatchInlineSnapshot(`
    "### Sixth level heading
    "
  `)
})

test('preserves h3 unchanged', () => {
  const input = '### Third level heading'
  const result = limitHeadingDepth(input)
  expect(result).toMatchInlineSnapshot(`"### Third level heading"`)
})

test('preserves h2 unchanged', () => {
  const input = '## Second level heading'
  const result = limitHeadingDepth(input)
  expect(result).toMatchInlineSnapshot(`"## Second level heading"`)
})

test('preserves h1 unchanged', () => {
  const input = '# First level heading'
  const result = limitHeadingDepth(input)
  expect(result).toMatchInlineSnapshot(`"# First level heading"`)
})

test('handles multiple headings in document', () => {
  const input = `# Title

Some text

## Section

### Subsection

#### Too deep

##### Even deeper

Regular paragraph

### Back to normal
`
  const result = limitHeadingDepth(input)
  expect(result).toMatchInlineSnapshot(`
    "# Title

    Some text

    ## Section

    ### Subsection

    ### Too deep
    ### Even deeper
    Regular paragraph

    ### Back to normal
    "
  `)
})

test('preserves heading with inline formatting', () => {
  const input = '#### Heading with **bold** and `code`'
  const result = limitHeadingDepth(input)
  expect(result).toMatchInlineSnapshot(`
    "### Heading with **bold** and \`code\`
    "
  `)
})

test('handles empty markdown', () => {
  const result = limitHeadingDepth('')
  expect(result).toMatchInlineSnapshot(`""`)
})

test('handles markdown with no headings', () => {
  const input = 'Just some text\n\nAnd more text'
  const result = limitHeadingDepth(input)
  expect(result).toMatchInlineSnapshot(`
    "Just some text

    And more text"
  `)
})

test('allows custom maxDepth', () => {
  const input = '### Third level'
  const result = limitHeadingDepth(input, 2)
  expect(result).toMatchInlineSnapshot(`
    "## Third level
    "
  `)
})
