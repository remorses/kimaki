// Tests for ! shell command output streaming: paging, tail truncation,
// bounded buffer line accounting, and the real process flow.

import { describe, expect, test } from 'vitest'
import {
  createShellOutputBuffer,
  renderShellOutputPages,
  streamShellCommand,
} from './run-command.js'

const FOOTER = '-# exit 0'

function countShownLines(pages: string[]): { shown: number; hidden: number } {
  const bodies = pages.map((page) => {
    return page.split('```')[1]!.replace(/^\n|\n$/g, '')
  })
  const lines = bodies.flatMap((body) => body.split('\n'))
  const marker = lines.find((line) => /^\.\.\. (\d+ lines? hidden)?(, )?(long lines cut)?$/.test(line))
  const hidden = Number(marker?.match(/(\d+) lines? hidden/)?.[1] ?? 0)
  return { shown: lines.filter((line) => line !== marker).length, hidden }
}

describe('renderShellOutputPages', () => {
  test('cleans ansi, carriage returns and code fences', () => {
    const pages = renderShellOutputPages({
      output: '\n\u001b[31mred\u001b[0m\r\n10%\r50%\r100%\nhas ``` fence\n\n',
      droppedLines: 0,
      footer: FOOTER,
    })
    expect(pages).toMatchInlineSnapshot(`
      [
        "\`\`\`
      red
      100%
      has \`\`​\` fence
      \`\`\`
      -# exit 0",
      ]
    `)
  })

  test('no output renders only the footer', () => {
    expect(
      renderShellOutputPages({ output: '\n\n', droppedLines: 0, footer: FOOTER }),
    ).toEqual([FOOTER])
  })

  test('long output keeps head pages and a tail page with hidden line count', () => {
    const total = 2000
    const output = Array.from({ length: total }, (_, i) => `line ${i + 1}`).join('\n')
    const pages = renderShellOutputPages({ output, droppedLines: 0, footer: FOOTER })

    expect(pages.length).toBe(5)
    expect(pages.every((page) => page.length <= 2000)).toBe(true)
    expect(pages[0]!.startsWith('```\nline 1\n')).toBe(true)
    expect(pages.at(-1)!.endsWith(`line ${total}\n\`\`\`\n${FOOTER}`)).toBe(true)
    const { shown, hidden } = countShownLines(pages)
    expect(shown + hidden).toBe(total)
  })

  test('earlier pages stay stable while output grows', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `row ${i}`)
    const before = renderShellOutputPages({
      output: lines.slice(0, 300).join('\n'),
      droppedLines: 0,
      footer: FOOTER,
    })
    const after = renderShellOutputPages({
      output: lines.join('\n'),
      droppedLines: 0,
      footer: FOOTER,
    })
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1))
  })

  test('a very long line is split across pages', () => {
    const pages = renderShellOutputPages({
      output: 'x'.repeat(5000),
      droppedLines: 0,
      footer: FOOTER,
    })
    const tooLong = renderShellOutputPages({
      output: 'x'.repeat(12_000),
      droppedLines: 0,
      footer: FOOTER,
    })
    expect(tooLong.at(-1)!.split('\n')[1]).toMatchInlineSnapshot(`"... long lines cut"`)
    expect(pages.map((page) => page.length)).toMatchInlineSnapshot(`
      [
        1880,
        1880,
        1274,
      ]
    `)
  })
})

describe('createShellOutputBuffer', () => {
  test('bounded buffer still counts every hidden line', () => {
    const total = 50_000
    const buffer = createShellOutputBuffer()
    // Odd chunk sizes so chunk and line boundaries never line up.
    const text = Array.from({ length: total }, (_, i) => `output line ${i + 1}\n`).join('')
    for (let start = 0; start < text.length; start += 777) {
      buffer.append(text.slice(start, start + 777))
    }
    const snapshot = buffer.snapshot()
    expect(snapshot.output.length).toBeLessThan(20_000)

    const pages = renderShellOutputPages({ ...snapshot, footer: FOOTER })
    const { shown, hidden } = countShownLines(pages)
    expect(shown + hidden).toBe(total)
    expect(pages.at(-1)!).toContain(`output line ${total}\n`)
  })
})

describe('streamShellCommand', () => {
  test('interleaves stdout and stderr and ends with the exit code', async () => {
    const sent: string[] = []
    await streamShellCommand({
      command: 'echo out-1; echo err-1 >&2; echo out-2; exit 3',
      directory: process.cwd(),
      sendPage: async ({ index, content }) => {
        sent[index] = content
        return {
          edit: async (next) => {
            sent[index] = next
          },
          delete: async () => {
            sent.splice(index, 1)
          },
        }
      },
    })
    const normalized = sent.map((content) => {
      return content.replace(/⋅ [\d.]+m?s$/, '⋅ Ns')
    })
    expect(normalized).toMatchInlineSnapshot(`
      [
        "\`\`\`
      out-1
      err-1
      out-2
      \`\`\`
      -# exit 3 ⋅ Ns",
      ]
    `)
  })
})

describe('streamShellCommand delivery failure', () => {
  test('posts the exit status separately when the output message cannot be edited', async () => {
    const sent: string[] = []
    await streamShellCommand({
      command: 'echo done',
      directory: process.cwd(),
      sendPage: async ({ content }) => {
        sent.push(content)
        return {
          edit: async () => {
            throw new Error('Unknown Message')
          },
          delete: async () => {},
        }
      },
    })
    expect(sent.map((content) => content.replace(/⋅ [\d.]+m?s/, '⋅ Ns'))).toMatchInlineSnapshot(`
      [
        "-# running...",
        "-# exit 0 ⋅ Ns ⋅ output message could not be updated",
      ]
    `)
  })
})

