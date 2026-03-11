// usecomputer CLI entrypoint and command wiring for desktop automation actions.

import { goke } from 'goke'
import { z } from 'zod'
import dedent from 'string-dedent'
import { createRequire } from 'node:module'
import url from 'node:url'
import { createBridge } from './bridge.js'
import { parseDirection, parseModifiers, parsePoint, parseRegion } from './command-parsers.js'
import type { MouseButton, Point, UseComputerBridge } from './types.js'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json') as { version: string }

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`)
}

function parsePointOrThrow(input: string): Point {
  const parsed = parsePoint(input)
  if (parsed instanceof Error) {
    throw parsed
  }
  return parsed
}

function parseButton(input?: string): MouseButton {
  if (input === 'right' || input === 'middle') {
    return input
  }
  return 'left'
}

function notImplemented({ command }: { command: string }): never {
  throw new Error(`Command \"${command}\" is not implemented yet`)
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
    .option('--display [display]', z.number().describe('Display index for multi-monitor setups'))
    .option('--annotate', 'Annotate screenshot with labels')
    .option('--json', 'Output as JSON')
    .action(async (path, options) => {
      const region = options.region ? parseRegion(options.region) : undefined
      if (region instanceof Error) {
        throw region
      }
      const result = await bridge.screenshot({
        path,
        region,
        display: options.display,
        annotate: options.annotate,
      })
      if (options.json) {
        printJson(result)
        return
      }
      printLine(result.path)
    })

  cli
    .command('click <target>', 'Click at x,y coordinates')
    .option('--button [button]', z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'))
    .option('--count [count]', z.number().default(1).describe('Number of clicks'))
    .option('--modifiers [modifiers]', z.string().describe('Modifiers as ctrl,shift,alt,meta'))
    .action(async (target, options) => {
      const point = parsePointOrThrow(target)
      await bridge.click({
        point,
        button: options.button,
        count: options.count,
        modifiers: parseModifiers(options.modifiers),
      })
    })

  cli
    .command('type <text>', 'Type text in the focused element')
    .option('--delay [delay]', z.number().describe('Delay in milliseconds between keystrokes'))
    .action(async (text, options) => {
      await bridge.typeText({ text, delayMs: options.delay })
    })

  cli
    .command('press <key>', 'Press a key or key combo')
    .option('--count [count]', z.number().default(1).describe('How many times to press'))
    .option('--delay [delay]', z.number().describe('Delay between presses in milliseconds'))
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
    .action(async (from, to, options) => {
      await bridge.drag({
        from: parsePointOrThrow(from),
        to: parsePointOrThrow(to),
        durationMs: options.duration,
        button: options.button,
      })
    })

  cli
    .command('hover <target>', 'Move mouse cursor to x,y without clicking')
    .action(async (target) => {
      await bridge.hover(parsePointOrThrow(target))
    })

  cli
    .command('mouse move <x> <y>', 'Move mouse cursor to absolute coordinates')
    .action(async (x, y) => {
      await bridge.mouseMove({ x: Number(x), y: Number(y) })
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
      displays.forEach((display) => {
        const primary = display.isPrimary ? ' (primary)' : ''
        printLine(
          `#${display.id} ${display.name}${primary} ${display.width}x${display.height} @ (${display.x},${display.y}) scale=${display.scale}`,
        )
      })
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

const isEntrypoint = (() => {
  const argvPath = process.argv[1]
  if (!argvPath) {
    return false
  }
  return import.meta.url === url.pathToFileURL(argvPath).href
})()

if (isEntrypoint) {
  const cli = createCli()
  cli.parse()
}
