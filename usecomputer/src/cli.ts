// usecomputer CLI entrypoint and command wiring for desktop automation actions.

import { goke } from 'goke'
import pc from 'picocolors'
import { z } from 'zod'
import dedent from 'string-dedent'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import pathModule from 'node:path'
import url from 'node:url'
import { createBridge } from './bridge.js'
import {
  getRegionFromCoordMap,
  mapPointFromCoordMap,
  mapPointToCoordMap,
  parseCoordMapOrThrow,
} from './coord-map.js'
import { parseDirection, parseModifiers, parsePoint, parseRegion } from './command-parsers.js'
import { drawDebugPointOnImage } from './debug-point-image.js'
import { renderAlignedTable } from './terminal-table.js'
import type { DisplayInfo, MouseButton, Point, UseComputerBridge, WindowInfo } from './types.js'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json') as { version: string }

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`)
}

function readTextFromStdin(): string {
  return fs.readFileSync(0, 'utf8')
}

function parsePositiveInteger({
  value,
  option,
}: {
  value?: number
  option: string
}): number | undefined {
  if (typeof value !== 'number') {
    return undefined
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Option ${option} must be a positive number`)
  }
  return Math.round(value)
}

function splitIntoChunks({
  text,
  chunkSize,
}: {
  text: string
  chunkSize?: number
}): string[] {
  if (!chunkSize || text.length <= chunkSize) {
    return [text]
  }
  const chunkCount = Math.ceil(text.length / chunkSize)
  return Array.from({ length: chunkCount }, (_, index) => {
    const start = index * chunkSize
    const end = start + chunkSize
    return text.slice(start, end)
  }).filter((chunk) => {
    return chunk.length > 0
  })
}

function sleep({
  ms,
}: {
  ms: number
}): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

function parsePointOrThrow(input: string): Point {
  const parsed = parsePoint(input)
  if (parsed instanceof Error) {
    throw parsed
  }
  return parsed
}


function resolveOutputPath({ path }: { path?: string }): string | undefined {
  if (!path) {
    return undefined
  }

  return path.startsWith('/')
    ? path
    : `${process.cwd()}/${path}`
}

function ensureParentDirectory({ filePath }: { filePath?: string }): void {
  if (!filePath) {
    return
  }

  const parentDirectory = pathModule.dirname(filePath)
  fs.mkdirSync(parentDirectory, { recursive: true })
}

function resolvePointInput({
  x,
  y,
  target,
  command,
}: {
  x?: number
  y?: number
  target?: string
  command: string
}): Point {
  if (typeof x === 'number' || typeof y === 'number') {
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new Error(`Command \"${command}\" requires both -x and -y when using coordinate flags`)
    }
    return { x, y }
  }
  if (target) {
    return parsePointOrThrow(target)
  }
  throw new Error(`Command \"${command}\" requires coordinates. Use -x <n> -y <n>`)
}

function parseButton(input?: string): MouseButton {
  if (input === 'right' || input === 'middle') {
    return input
  }
  return 'left'
}

function printDesktopList({ displays }: { displays: DisplayInfo[] }) {
  const rows = displays.map((display) => {
    return {
      desktop: `#${display.index}`,
      primary: display.isPrimary ? pc.green('yes') : 'no',
      size: `${display.width}x${display.height}`,
      position: `${display.x},${display.y}`,
      id: String(display.id),
      scale: String(display.scale),
      name: display.name,
    }
  })

  const lines = renderAlignedTable({
    rows,
    columns: [
      { header: pc.bold('desktop'), value: (row) => { return row.desktop } },
      { header: pc.bold('primary'), value: (row) => { return row.primary } },
      { header: pc.bold('size'), value: (row) => { return row.size }, align: 'right' },
      { header: pc.bold('position'), value: (row) => { return row.position }, align: 'right' },
      { header: pc.bold('id'), value: (row) => { return row.id }, align: 'right' },
      { header: pc.bold('scale'), value: (row) => { return row.scale }, align: 'right' },
      { header: pc.bold('name'), value: (row) => { return row.name } },
    ],
  })
  lines.forEach((line) => {
    printLine(line)
  })
}

function mapWindowsByDesktopIndex({
  windows,
}: {
  windows: WindowInfo[]
}): Map<number, WindowInfo[]> {
  return windows.reduce((acc, window) => {
    const list = acc.get(window.desktopIndex) ?? []
    list.push(window)
    acc.set(window.desktopIndex, list)
    return acc
  }, new Map<number, WindowInfo[]>())
}

function printDesktopListWithWindows({
  displays,
  windows,
}: {
  displays: DisplayInfo[]
  windows: WindowInfo[]
}) {
  const windowsByDesktop = mapWindowsByDesktopIndex({ windows })
  printDesktopList({ displays })

  displays.forEach((display) => {
    printLine('')
    printLine(pc.bold(pc.cyan(`desktop #${display.index} windows`)))

    const desktopWindows = windowsByDesktop.get(display.index) ?? []
    if (desktopWindows.length === 0) {
      printLine(pc.dim('none'))
      return
    }

    const lines = renderAlignedTable({
      rows: desktopWindows,
      columns: [
        { header: pc.bold('id'), value: (row) => { return String(row.id) }, align: 'right' },
        { header: pc.bold('app'), value: (row) => { return row.ownerName } },
        { header: pc.bold('pid'), value: (row) => { return String(row.ownerPid) }, align: 'right' },
        { header: pc.bold('size'), value: (row) => { return `${row.width}x${row.height}` }, align: 'right' },
        { header: pc.bold('position'), value: (row) => { return `${row.x},${row.y}` }, align: 'right' },
        { header: pc.bold('title'), value: (row) => { return row.title } },
      ],
    })
    lines.forEach((line) => {
      printLine(line)
    })
  })
}

function printWindowList({ windows }: { windows: WindowInfo[] }) {
  const lines = renderAlignedTable({
    rows: windows,
    columns: [
      { header: pc.bold('id'), value: (row) => { return String(row.id) }, align: 'right' },
      { header: pc.bold('desktop'), value: (row) => { return `#${row.desktopIndex}` }, align: 'right' },
      { header: pc.bold('app'), value: (row) => { return row.ownerName } },
      { header: pc.bold('pid'), value: (row) => { return String(row.ownerPid) }, align: 'right' },
      { header: pc.bold('size'), value: (row) => { return `${row.width}x${row.height}` }, align: 'right' },
      { header: pc.bold('position'), value: (row) => { return `${row.x},${row.y}` }, align: 'right' },
      { header: pc.bold('title'), value: (row) => { return row.title } },
    ],
  })
  lines.forEach((line) => {
    printLine(line)
  })
}

function notImplemented({ command }: { command: string }): never {
  throw new Error(`TODO not implemented: ${command}`)
}

export function createCli({ bridge = createBridge() }: { bridge?: UseComputerBridge } = {}) {
  const cli = goke('usecomputer')

  cli
    .command(
      'screenshot [path]',
      dedent`
        Take a screenshot of the entire screen or a region.

        This command uses a native Zig backend over macOS APIs.
      `,
    )
    .option('-r, --region [region]', z.string().describe('Capture region as x,y,width,height'))
    .option(
      '--display [display]',
      z.number().describe('Display index for multi-monitor setups (0-based: first display is index 0)'),
    )
    .option('--window [window]', z.number().describe('Capture a specific window by window id'))
    .option('--annotate', 'Annotate screenshot with labels')
    .option('--json', 'Output as JSON')
    .action(async (path, options) => {
      const outputPath = resolveOutputPath({ path })
      ensureParentDirectory({ filePath: outputPath })
      const region = options.region ? parseRegion(options.region) : undefined
      if (region instanceof Error) {
        throw region
      }
      if (typeof options.window === 'number' && region) {
        throw new Error('Cannot use --window and --region together')
      }
      if (typeof options.window === 'number' && typeof options.display === 'number') {
        throw new Error('Cannot use --window and --display together')
      }
      const result = await bridge.screenshot({
        path: outputPath,
        region,
        display: options.display,
        window: options.window,
        annotate: options.annotate,
      })
      if (options.json) {
        printJson(result)
        return
      }
      printLine(result.path)
      printLine(result.hint)
      printLine(`desktop-index=${String(result.desktopIndex)}`)
    })

  cli
    .command(
      'click [target]',
      dedent`
        Click at coordinates.

        When you are clicking from a screenshot, use the exact pixel coordinates
        of the target in that screenshot image and always pass the exact
        --coord-map value printed by usecomputer screenshot. The coord map
        scales screenshot-space pixels back into the real captured desktop or
        window rectangle before sending the native click.
      `,
    )
    .option('-x [x]', z.number().describe('X coordinate. When using --coord-map, this must be the exact pixel from the screenshot image'))
    .option('-y [y]', z.number().describe('Y coordinate. When using --coord-map, this must be the exact pixel from the screenshot image'))
    .option('--button [button]', z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'))
    .option('--count [count]', z.number().default(1).describe('Number of clicks'))
    .option('--modifiers [modifiers]', z.string().describe('Modifiers as ctrl,shift,alt,meta'))
    .option('--coord-map [coordMap]', z.string().describe('Map exact screenshot-space pixels back into the real captured desktop or window rectangle'))
    .example('# Click the exact pixel you saw in a screenshot')
    .example('usecomputer click -x 155 -y 446 --coord-map "0,0,1720,1440,1568,1313"')
    .action(async (target, options) => {
      const point = resolvePointInput({
        x: options.x,
        y: options.y,
        target,
        command: 'click',
      })
      const coordMap = parseCoordMapOrThrow(options.coordMap)
      await bridge.click({
        point: mapPointFromCoordMap({ point, coordMap }),
        button: options.button,
        count: options.count,
        modifiers: parseModifiers(options.modifiers),
      })
    })

  cli
    .command(
      'debug-point [target]',
      dedent`
        Capture a screenshot and draw a red marker where a click would land.

        Pass the same --coord-map you plan to use for click. This validates
        screenshot-space coordinates before you send a real click. When
        --coord-map is present, debug-point captures that same region so the
        overlay matches the screenshot you are targeting.
      `,
    )
    .option('-x [x]', z.number().describe('X coordinate'))
    .option('-y [y]', z.number().describe('Y coordinate'))
    .option('--coord-map [coordMap]', z.string().describe('Map input coordinates from screenshot space'))
    .option('--output [path]', z.string().describe('Write the annotated screenshot to this path'))
    .option('--json', 'Output as JSON')
    .example('# Validate the same coordinates you plan to click')
    .example('usecomputer debug-point -x 210 -y 560 --coord-map "0,0,1720,1440,1568,1313"')
    .action(async (target, options) => {
      const point = resolvePointInput({
        x: options.x,
        y: options.y,
        target,
        command: 'debug-point',
      })
      const inputCoordMap = parseCoordMapOrThrow(options.coordMap)
      const desktopPoint = mapPointFromCoordMap({ point, coordMap: inputCoordMap })
      const outputPath = resolveOutputPath({ path: options.output ?? './tmp/debug-point.png' })
      ensureParentDirectory({ filePath: outputPath })
      const screenshotRegion = getRegionFromCoordMap({ coordMap: inputCoordMap })

      const screenshot = await bridge.screenshot({
        path: outputPath,
        region: screenshotRegion,
      })
      const screenshotCoordMap = parseCoordMapOrThrow(screenshot.coordMap)
      const screenshotPoint = mapPointToCoordMap({ point: desktopPoint, coordMap: screenshotCoordMap })

      await drawDebugPointOnImage({
        imagePath: screenshot.path,
        point: screenshotPoint,
        imageWidth: screenshot.imageWidth,
        imageHeight: screenshot.imageHeight,
      })

      if (options.json) {
        printJson({
          path: screenshot.path,
          inputPoint: point,
          desktopPoint,
          screenshotPoint,
          inputCoordMap: options.coordMap ?? null,
          screenshotCoordMap: screenshot.coordMap,
          hint: screenshot.hint,
        })
        return
      }

      printLine(screenshot.path)
      printLine(`input-point=${point.x},${point.y}`)
      printLine(`desktop-point=${desktopPoint.x},${desktopPoint.y}`)
      printLine(`screenshot-point=${screenshotPoint.x},${screenshotPoint.y}`)
      printLine(screenshot.hint)
    })

  cli
    .command(
      'type [text]',
      dedent`
        Type text in the currently focused input.

        Supports direct text arguments or --stdin for long/multiline content.
        For very long text, use --chunk-size to split input into multiple native
        type calls so shells and apps are less likely to drop input.
      `,
    )
    .option('--stdin', 'Read text from stdin instead of [text] argument')
    .option('--delay [delay]', z.number().describe('Delay in milliseconds between typed characters'))
    .option('--chunk-size [size]', z.number().describe('Split text into fixed-size chunks before typing'))
    .option('--chunk-delay [delay]', z.number().describe('Delay in milliseconds between chunks'))
    .option('--max-length [length]', z.number().describe('Fail when input text exceeds this maximum length'))
    .example('# Type a short string')
    .example('usecomputer type "hello"')
    .example('# Type multiline text from a file')
    .example('cat ./notes.txt | usecomputer type --stdin --chunk-size 4000 --chunk-delay 15')
    .action(async (text, options) => {
      const fromStdin = Boolean(options.stdin)
      if (fromStdin && text) {
        throw new Error('Use either [text] or --stdin, not both')
      }
      if (!fromStdin && !text) {
        throw new Error('Command "type" requires [text] or --stdin')
      }

      const sourceText = fromStdin ? readTextFromStdin() : text ?? ''
      const chunkSize = parsePositiveInteger({
        value: options.chunkSize,
        option: '--chunk-size',
      })
      const maxLength = parsePositiveInteger({
        value: options.maxLength,
        option: '--max-length',
      })
      const chunkDelay = parsePositiveInteger({
        value: options.chunkDelay,
        option: '--chunk-delay',
      })

      if (typeof maxLength === 'number' && sourceText.length > maxLength) {
        throw new Error(`Input text length ${String(sourceText.length)} exceeds --max-length ${String(maxLength)}`)
      }

      const chunks = splitIntoChunks({
        text: sourceText,
        chunkSize,
      })
      await chunks.reduce(async (previousChunk, chunk, index) => {
        await previousChunk
        await bridge.typeText({
          text: chunk,
          delayMs: options.delay,
        })
        if (typeof chunkDelay === 'number' && index < chunks.length - 1) {
          await sleep({ ms: chunkDelay })
        }
      }, Promise.resolve())
    })

  cli
    .command(
      'press <key>',
      dedent`
        Press a key or key combo in the focused app.

        Key combos use plus syntax such as cmd+s or ctrl+shift+p.
        Platform behavior: cmd maps to Command on macOS, Win/Super on
        Windows/Linux. For cross-platform app shortcuts, prefer ctrl+... .
      `,
    )
    .option('--count [count]', z.number().default(1).describe('How many times to press'))
    .option('--delay [delay]', z.number().describe('Delay between presses in milliseconds'))
    .example('# Save in the current app on macOS')
    .example('usecomputer press "cmd+s"')
    .example('# Portable save shortcut across most apps')
    .example('usecomputer press "ctrl+s"')
    .example('# Open command palette in many editors')
    .example('usecomputer press "cmd+shift+p"')
    .action(async (key, options) => {
      await bridge.press({ key, count: options.count, delayMs: options.delay })
    })

  cli
    .command('scroll <direction> [amount]', 'Scroll in a direction')
    .option('--at [at]', z.string().describe('Coordinates x,y where scroll happens'))
    .action(async (direction, amount, options) => {
      const parsedDirection = parseDirection(direction)
      if (parsedDirection instanceof Error) {
        throw parsedDirection
      }
      const at = options.at ? parsePointOrThrow(options.at) : undefined
      const scrollAmount = amount ? Number(amount) : 300
      if (!Number.isFinite(scrollAmount)) {
        throw new Error(`Invalid amount \"${amount}\"`)
      }
      await bridge.scroll({
        direction: parsedDirection,
        amount: scrollAmount,
        at,
      })
    })

  cli
    .command('drag <from> <to>', 'Drag from one coordinate to another')
    .option('--duration [duration]', z.number().describe('Duration in milliseconds'))
    .option('--button [button]', z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'))
    .option('--coord-map [coordMap]', z.string().describe('Map input coordinates from screenshot space'))
    .action(async (from, to, options) => {
      const coordMap = parseCoordMapOrThrow(options.coordMap)
      await bridge.drag({
        from: mapPointFromCoordMap({ point: parsePointOrThrow(from), coordMap }),
        to: mapPointFromCoordMap({ point: parsePointOrThrow(to), coordMap }),
        durationMs: options.duration,
        button: options.button,
      })
    })

  cli
    .command('hover [target]', 'Move mouse cursor to coordinates without clicking')
    .option('-x [x]', z.number().describe('X coordinate'))
    .option('-y [y]', z.number().describe('Y coordinate'))
    .option('--coord-map [coordMap]', z.string().describe('Map input coordinates from screenshot space'))
    .action(async (target, options) => {
      const point = resolvePointInput({
        x: options.x,
        y: options.y,
        target,
        command: 'hover',
      })
      const coordMap = parseCoordMapOrThrow(options.coordMap)
      await bridge.hover(mapPointFromCoordMap({ point, coordMap }))
    })

  cli
    .command('mouse move [x] [y]', 'Move mouse cursor to absolute coordinates (optional before click; click can target coordinates directly)')
    .option('-x [x]', z.number().describe('X coordinate'))
    .option('-y [y]', z.number().describe('Y coordinate'))
    .option('--coord-map [coordMap]', z.string().describe('Map input coordinates from screenshot space'))
    .action(async (x, y, options) => {
      const point = resolvePointInput({
        x: options.x,
        y: options.y,
        target: x && y ? `${x},${y}` : undefined,
        command: 'mouse move',
      })
      const coordMap = parseCoordMapOrThrow(options.coordMap)
      await bridge.mouseMove(mapPointFromCoordMap({ point, coordMap }))
    })

  cli
    .command('mouse down', 'Press and hold mouse button')
    .option('--button [button]', z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'))
    .action(async (options) => {
      await bridge.mouseDown({ button: parseButton(options.button) })
    })

  cli
    .command('mouse up', 'Release mouse button')
    .option('--button [button]', z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'))
    .action(async (options) => {
      await bridge.mouseUp({ button: parseButton(options.button) })
    })

  cli
    .command('mouse position', 'Print current mouse position as x,y')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const position = await bridge.mousePosition()
      if (options.json) {
        printJson(position)
        return
      }
      printLine(`${position.x},${position.y}`)
    })

  cli
    .command('display list', 'List connected displays')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const displays = await bridge.displayList()
      if (options.json) {
        printJson(displays)
        return
      }
      printDesktopList({ displays })
    })

  cli
    .command('desktop list', 'List desktops as display indexes and sizes (#0 is the primary display)')
    .option('--windows', 'Include available windows grouped by desktop index')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const displays = await bridge.displayList()
      const windows = options.windows ? await bridge.windowList() : []
      if (options.json) {
        if (options.windows) {
          printJson({ displays, windows })
          return
        }
        printJson(displays)
        return
      }
      if (options.windows) {
        printDesktopListWithWindows({ displays, windows })
        return
      }
      printDesktopList({ displays })
    })

  cli
    .command('clipboard get', 'Print clipboard text')
    .action(async () => {
      const text = await bridge.clipboardGet()
      printLine(text)
    })

  cli
    .command('clipboard set <text>', 'Set clipboard text')
    .action(async (text) => {
      await bridge.clipboardSet({ text })
    })

  cli.command('snapshot').action(() => {
    notImplemented({ command: 'snapshot' })
  })
  cli.command('get text <target>').action(() => {
    notImplemented({ command: 'get text' })
  })
  cli.command('get title <target>').action(() => {
    notImplemented({ command: 'get title' })
  })
  cli.command('get value <target>').action(() => {
    notImplemented({ command: 'get value' })
  })
  cli.command('get bounds <target>').action(() => {
    notImplemented({ command: 'get bounds' })
  })
  cli.command('get focused').action(() => {
    notImplemented({ command: 'get focused' })
  })
  cli.command('window list').option('--json', 'Output as JSON').action(async (options) => {
    const windows = await bridge.windowList()
    if (options.json) {
      printJson(windows)
      return
    }
    printWindowList({ windows })
  })
  cli.command('window focus <target>').action(() => {
    notImplemented({ command: 'window focus' })
  })
  cli.command('window resize <target> <width> <height>').action(() => {
    notImplemented({ command: 'window resize' })
  })
  cli.command('window move <target> <x> <y>').action(() => {
    notImplemented({ command: 'window move' })
  })
  cli.command('window minimize <target>').action(() => {
    notImplemented({ command: 'window minimize' })
  })
  cli.command('window maximize <target>').action(() => {
    notImplemented({ command: 'window maximize' })
  })
  cli.command('window close <target>').action(() => {
    notImplemented({ command: 'window close' })
  })
  cli.command('app list').action(() => {
    notImplemented({ command: 'app list' })
  })
  cli.command('app launch <name>').action(() => {
    notImplemented({ command: 'app launch' })
  })
  cli.command('app quit <name>').action(() => {
    notImplemented({ command: 'app quit' })
  })
  cli.command('wait <target>').action(() => {
    notImplemented({ command: 'wait' })
  })
  cli.command('find <query>').action(() => {
    notImplemented({ command: 'find' })
  })
  cli.command('diff snapshot').action(() => {
    notImplemented({ command: 'diff snapshot' })
  })
  cli.command('diff screenshot').action(() => {
    notImplemented({ command: 'diff screenshot' })
  })

  cli.help()
  cli.version(packageJson.version)
  return cli
}

export function runCli(): void {
  const cli = createCli()
  cli.parse()
}

const isDirectEntrypoint = (() => {
  const argvPath = process.argv[1]
  if (!argvPath) {
    return false
  }
  return import.meta.url === url.pathToFileURL(argvPath).href
})()

if (isDirectEntrypoint) {
  runCli()
}
