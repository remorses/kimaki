import { test, expect } from 'vitest'
import { formatMarkdownTables } from './format-tables.js'

test('formats simple table', () => {
  const input = `| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Name  Age
    ----- ---
    Alice 30 
    Bob   25 
    \`\`\`
    "
  `)
})

test('formats table with varying column widths', () => {
  const input = `| Item | Quantity | Price |
| --- | --- | --- |
| Apples | 10 | $5 |
| Oranges | 3 | $2 |
| Bananas with long name | 100 | $15.99 |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Item                   Quantity Price 
    ---------------------- -------- ------
    Apples                 10       $5    
    Oranges                3        $2    
    Bananas with long name 100      $15.99
    \`\`\`
    "
  `)
})

test('strips bold formatting from cells', () => {
  const input = `| Header | Value |
| --- | --- |
| **Bold text** | Normal |
| Mixed **bold** text | Another |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Header          Value  
    --------------- -------
    Bold text       Normal 
    Mixed bold text Another
    \`\`\`
    "
  `)
})

test('strips italic formatting from cells', () => {
  const input = `| Header | Value |
| --- | --- |
| *Italic text* | Normal |
| _Also italic_ | Another |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Header      Value  
    ----------- -------
    Italic text Normal 
    Also italic Another
    \`\`\`
    "
  `)
})

test('extracts URL from links', () => {
  const input = `| Name | Link |
| --- | --- |
| Google | [Click here](https://google.com) |
| GitHub | [GitHub Home](https://github.com) |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Name   Link              
    ------ ------------------
    Google https://google.com
    GitHub https://github.com
    \`\`\`
    "
  `)
})

test('handles inline code in cells', () => {
  const input = `| Function | Description |
| --- | --- |
| \`console.log\` | Logs to console |
| \`Array.map\` | Maps array items |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Function    Description     
    ----------- ----------------
    console.log Logs to console 
    Array.map   Maps array items
    \`\`\`
    "
  `)
})

test('handles mixed formatting in single cell', () => {
  const input = `| Description |
| --- |
| This has **bold**, *italic*, and \`code\` |
| Also [a link](https://example.com) here |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Description                    
    -------------------------------
    This has bold, italic, and code
    Also https://example.com here  
    \`\`\`
    "
  `)
})

test('handles strikethrough text', () => {
  const input = `| Status | Item |
| --- | --- |
| Done | ~~Deleted item~~ |
| Active | Normal item |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Status Item        
    ------ ------------
    Done   Deleted item
    Active Normal item 
    \`\`\`
    "
  `)
})

test('preserves content before table', () => {
  const input = `Here is some text before the table.

| Col A | Col B |
| --- | --- |
| 1 | 2 |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "Here is some text before the table.

    \`\`\`
    Col A Col B
    ----- -----
    1     2    
    \`\`\`
    "
  `)
})

test('preserves content after table', () => {
  const input = `| Col A | Col B |
| --- | --- |
| 1 | 2 |

And here is text after.`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Col A Col B
    ----- -----
    1     2    
    \`\`\`
    And here is text after."
  `)
})

test('preserves content before and after table', () => {
  const input = `Some intro text.

| Name | Value |
| --- | --- |
| Key | 123 |

Some outro text.`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "Some intro text.

    \`\`\`
    Name Value
    ---- -----
    Key  123  
    \`\`\`
    Some outro text."
  `)
})

test('handles multiple tables in same content', () => {
  const input = `First table:

| A | B |
| --- | --- |
| 1 | 2 |

Some text between.

Second table:

| X | Y | Z |
| --- | --- | --- |
| a | b | c |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "First table:

    \`\`\`
    A B
    - -
    1 2
    \`\`\`
    Some text between.

    Second table:

    \`\`\`
    X Y Z
    - - -
    a b c
    \`\`\`
    "
  `)
})

test('handles empty cells', () => {
  const input = `| Name | Optional |
| --- | --- |
| Alice | |
| | Bob |
| | |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Name  Optional
    ----- --------
    Alice         
          Bob     
                  
    \`\`\`
    "
  `)
})

test('handles single column table', () => {
  const input = `| Items |
| --- |
| Apple |
| Banana |
| Cherry |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Items 
    ------
    Apple 
    Banana
    Cherry
    \`\`\`
    "
  `)
})

test('handles single row table', () => {
  const input = `| A | B | C | D |
| --- | --- | --- | --- |
| 1 | 2 | 3 | 4 |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    A B C D
    - - - -
    1 2 3 4
    \`\`\`
    "
  `)
})

test('handles nested formatting', () => {
  const input = `| Description |
| --- |
| **Bold with *nested italic* inside** |
| *Italic with **nested bold** inside* |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Description                   
    ------------------------------
    Bold with nested italic inside
    Italic with nested bold inside
    \`\`\`
    "
  `)
})

test('handles image references', () => {
  const input = `| Icon | Name |
| --- | --- |
| ![alt](https://example.com/icon.png) | Item 1 |
| ![](https://cdn.test.com/img.jpg) | Item 2 |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Icon                         Name  
    ---------------------------- ------
    https://example.com/icon.png Item 1
    https://cdn.test.com/img.jpg Item 2
    \`\`\`
    "
  `)
})

test('preserves code blocks alongside tables', () => {
  const input = `Some code:

\`\`\`js
const x = 1
\`\`\`

A table:

| Key | Value |
| --- | --- |
| a | 1 |

More code:

\`\`\`python
print("hello")
\`\`\``
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "Some code:

    \`\`\`js
    const x = 1
    \`\`\`

    A table:

    \`\`\`
    Key Value
    --- -----
    a   1    
    \`\`\`
    More code:

    \`\`\`python
    print("hello")
    \`\`\`"
  `)
})

test('handles content without tables', () => {
  const input = `Just some regular markdown.

- List item 1
- List item 2

**Bold text** and *italic*.`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "Just some regular markdown.

    - List item 1
    - List item 2

    **Bold text** and *italic*."
  `)
})

test('handles complex real-world table', () => {
  const input = `## API Endpoints

| Method | Endpoint | Description | Auth |
| --- | --- | --- | --- |
| GET | \`/api/users\` | List all users | [Bearer token](https://docs.example.com/auth) |
| POST | \`/api/users\` | Create **new** user | Required |
| DELETE | \`/api/users/:id\` | ~~Remove~~ *Deactivate* user | Admin only |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "## API Endpoints

    \`\`\`
    Method Endpoint       Description            Auth                         
    ------ -------------- ---------------------- -----------------------------
    GET    /api/users     List all users         https://docs.example.com/auth
    POST   /api/users     Create new user        Required                     
    DELETE /api/users/:id Remove Deactivate user Admin only                   
    \`\`\`
    "
  `)
})

test('handles unicode content', () => {
  const input = `| Emoji | Name | Country |
| --- | --- | --- |
| 🍎 | Apple | 日本 |
| 🍊 | Orange | España |
| 🍌 | Banana | Ελλάδα |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Emoji Name   Country
    ----- ------ -------
    🍎    Apple  日本     
    🍊    Orange España 
    🍌    Banana Ελλάδα 
    \`\`\`
    "
  `)
})

test('handles numbers and special characters', () => {
  const input = `| Price | Discount | Final |
| --- | --- | --- |
| $100.00 | -15% | $85.00 |
| €50,00 | -10% | €45,00 |
| £75.99 | N/A | £75.99 |`
  const result = formatMarkdownTables(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`
    Price   Discount Final 
    ------- -------- ------
    $100.00 -15%     $85.00
    €50,00  -10%     €45,00
    £75.99  N/A      £75.99
    \`\`\`
    "
  `)
})
