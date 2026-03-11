// Parser tests for goke CLI options and flags.

import { describe, expect, test } from 'vitest'
import { createCli } from './cli.js'

describe('usecomputer cli parsing', () => {
  test('parses click options with typed defaults', () => {
    const cli = createCli()
    const parsed = cli.parse(['node', 'usecomputer', 'click', '100,200', '--count', '2'], { run: false })
    expect(parsed.args[0]).toBe('100,200')
    expect(parsed.options.count).toBe(2)
    expect(parsed.options.button).toBe('left')
  })

  test('parses screenshot options', () => {
    const cli = createCli()
    const parsed = cli.parse(['node', 'usecomputer', 'screenshot', './shot.png', '--display', '2', '--region', '0,0,120,80'], {
      run: false,
    })
    expect(parsed.args[0]).toBe('./shot.png')
    expect(parsed.options.display).toBe(2)
    expect(parsed.options.region).toBe('0,0,120,80')
  })

  test('parses coord-map option for click and mouse move', () => {
    const clickCli = createCli()
    const clickParsed = clickCli.parse(['node', 'usecomputer', 'click', '-x', '100', '-y', '200', '--coord-map', '0,0,1600,900,1568,882'], {
      run: false,
    })

    const moveCli = createCli()
    const moveParsed = moveCli.parse(['node', 'usecomputer', 'mouse', 'move', '-x', '100', '-y', '200', '--coord-map', '0,0,1600,900,1568,882'], {
      run: false,
    })

    expect(clickParsed.options.coordMap).toBe('0,0,1600,900,1568,882')
    expect(moveParsed.options.coordMap).toBe('0,0,1600,900,1568,882')
  })
})
