// usecomputer CLI entrypoint and command wiring for desktop automation actions.

import { goke } from 'goke'
import { z } from 'zod'
import dedent from 'string-dedent'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import pathModule from 'node:path'
import url from 'node:url'
import { createBridge } from './bridge.js'
import { parseDirection, parseModifiers, parsePoint, parseRegion } from './command-parsers.js'
import type { DisplayInfo, MouseButton, Point, UseComputerBridge } from './types.js'

const SCREENSHOT_COORD_MAP_HINT =
  'use --coord-map coordmap to use command like click, move etc on the coordinate system of this screenshot'

type CoordMap = {
  captureX: number
  captureY: number
  captureWidth: number
  captureHeight: number
  imageWidth: number
  imageHeight: number
}

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

function parseCoordMapOrThrow(input?: string): CoordMap | undefined {
  if (!input) {
    return undefined
  }

  const values = input.split(',').map((value) => {
    return Number(value.trim())
  })
  if (values.length !== 6 || values.some((value) => {
    return !Number.isFinite(value)
  })) {
    throw new Error('Option --coord-map must be x,y,width,height,imageWidth,imageHeight')
  }

  const [captureX, captureY, captureWidth, captureHeight, imageWidth, imageHeight] = values
  if (captureWidth <= 0 || captureHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    throw new Error('Option --coord-map must have positive width and height values')
  }

  return {
    captureX,
    captureY,
    captureWidth,
    captureHeight,
    imageWidth,
    imageHeight,
  }
}

function mapPointFromCoordMap({
  point,
  coordMap,
}: {
  point: Point
  coordMap?: CoordMap
}): Point {
  if (!coordMap) {
    return point
  }

  const mappedX = coordMap.captureX + (point.x / coordMap.imageWidth) * coordMap.captureWidth
  const mappedY = coordMap.captureY + (point.y / coordMap.imageHeight) * coordMap.captureHeight

  const clampedX = Math.max(coordMap.captureX, Math.min(coordMap.captureX + coordMap.captureWidth, mappedX))
  const clampedY = Math.max(coordMap.captureY, Math.min(coordMap.captureY + coordMap.captureHeight, mappedY))
  return {
    x: Math.round(clampedX),
    y: Math.round(clampedY),
  }
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
  displays.forEach((display) => {
    const primary = display.isPrimary ? ' (primary)' : ''
    printLine(
      `#${display.index}${primary} ${display.width}x${display.height} @ (${display.x},${display.y}) id=${display.id} scale=${display.scale} ${display.name}`,
    )
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
    .option('--annotate', 'Annotate screenshot with labels')
    .option('--json', 'Output as JSON')
    .action(async (path, options) => {
      const outputPath = path
        ? path.startsWith('/')
          ? path
          : `${process.cwd()}/${path}`
        : undefined

      if (path) {
        const parentDirectory = pathModule.dirname(outputPath)
        fs.mkdirSync(parentDirectory, { recursive: true })
      }
      const region = options.region ? parseRegion(options.region) : undefined
      if (region instanceof Error) {
        throw region
      }
      const result = await bridge.screenshot({
        path: outputPath,
        region,
        display: options.display,
        annotate: options.annotate,
      })
      if (options.json) {
        printJson(result)
        return
      }
      printLine(result.path)
      printLine(result.hint)
      printLine(`coordmap=${result.coordMap}`)
      printLine(`desktop-index=${String(result.desktopIndex)}`)
    })

  cli
    .command('click [target]', 'Click at coordinates')
    .option('-x [x]', z.number().describe('X coordinate'))
    .option('-y [y]', z.number().describe('Y coordinate'))
    .option('--button [button]', z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'))
    .option('--count [count]', z.number().default(1).describe('Number of clicks'))
    .option('--modifiers [modifiers]', z.string().describe('Modifiers as ctrl,shift,alt,meta'))
    .option('--coord-map [coordMap]', z.string().describe('Map input coordinates from screenshot space'))
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
  cli.command('window list').action(() => {
    notImplemented({ command: 'window list' })
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
