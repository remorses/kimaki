<!-- Purpose: npm package usage and install guide for usecomputer CLI. -->

# usecomputer

`usecomputer` is a macOS desktop automation CLI for AI agents.

It can move the mouse, click, drag, and query cursor position using native
Quartz events through a Zig N-API module.

Keyboard synthesis (`type` and `press`) is also available. The native backend
includes platform-specific key injection paths for macOS, Windows, and Linux
X11.

The package also exports the native commands as plain library functions, so you
can `import * as usecomputer from "usecomputer"` and reuse the same screenshot,
mouse, keyboard, and coord-map behavior from Node.js.

## Install

```bash
npm install -g usecomputer
```

## Requirements

- macOS (Darwin)
- Accessibility permission enabled for your terminal app

## Quick start

```bash
usecomputer mouse position --json
usecomputer mouse move -x 500 -y 500
usecomputer click -x 500 -y 500 --button left --count 1
usecomputer type "hello"
usecomputer press "cmd+s"
```

## Library usage

```ts
import * as usecomputer from 'usecomputer'

const screenshot = await usecomputer.screenshot({
  path: './tmp/shot.png',
  display: null,
  window: null,
  region: null,
  annotate: null,
})

const coordMap = usecomputer.parseCoordMapOrThrow(screenshot.coordMap)
const point = usecomputer.mapPointFromCoordMap({
  point: { x: 400, y: 220 },
  coordMap,
})

await usecomputer.click({
  point,
  button: 'left',
  count: 1,
})
```

These exported functions intentionally mirror the native command shapes used by
the Zig N-API module. Optional native fields are passed as `null` when absent.

## OpenAI computer tool example

```ts
import fs from 'node:fs'
import * as usecomputer from 'usecomputer'

async function sendComputerScreenshot() {
  const screenshot = await usecomputer.screenshot({
    path: './tmp/computer-tool.png',
    display: null,
    window: null,
    region: null,
    annotate: null,
  })

  return {
    screenshot,
    imageBase64: await fs.promises.readFile(screenshot.path, 'base64'),
  }
}

async function runComputerAction(action, coordMap) {
  if (action.type === 'click') {
    await usecomputer.click({
      point: usecomputer.mapPointFromCoordMap({
        point: { x: action.x, y: action.y },
        coordMap: usecomputer.parseCoordMapOrThrow(coordMap),
      }),
      button: action.button ?? 'left',
      count: 1,
    })
    return
  }

  if (action.type === 'double_click') {
    await usecomputer.click({
      point: usecomputer.mapPointFromCoordMap({
        point: { x: action.x, y: action.y },
        coordMap: usecomputer.parseCoordMapOrThrow(coordMap),
      }),
      button: action.button ?? 'left',
      count: 2,
    })
    return
  }

  if (action.type === 'scroll') {
    await usecomputer.scroll({
      direction: action.scrollY && action.scrollY < 0 ? 'up' : 'down',
      amount: Math.abs(action.scrollY ?? 0),
      at: typeof action.x === 'number' && typeof action.y === 'number'
        ? usecomputer.mapPointFromCoordMap({
            point: { x: action.x, y: action.y },
            coordMap: usecomputer.parseCoordMapOrThrow(coordMap),
          })
        : null,
    })
    return
  }

  if (action.type === 'keypress') {
    await usecomputer.press({
      key: action.keys.join('+'),
      count: 1,
      delayMs: null,
    })
    return
  }

  if (action.type === 'type') {
    await usecomputer.typeText({
      text: action.text,
      delayMs: null,
    })
}
}
```

## Anthropic computer use example

Anthropic's computer tool uses action names like `left_click`, `double_click`,
`mouse_move`, `key`, `type`, `scroll`, and `screenshot`. `usecomputer`
provides the execution layer for those actions.

```ts
import fs from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import * as usecomputer from 'usecomputer'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const message = await anthropic.beta.messages.create({
  model: 'claude-opus-4-6',
  max_tokens: 1024,
  tools: [
    {
      type: 'computer_20251124',
      name: 'computer',
      display_width_px: 1024,
      display_height_px: 768,
      display_number: 1,
    },
  ],
  messages: [{ role: 'user', content: 'Open Safari and search for usecomputer.' }],
  betas: ['computer-use-2025-11-24'],
})

for (const block of message.content) {
  if (block.type !== 'tool_use' || block.name !== 'computer') {
    continue
  }

  const toolUse = block as BetaToolUseBlock
  const beforeActionScreenshot = await usecomputer.screenshot({
    path: './tmp/claude-current-screen.png',
    display: null,
    window: null,
    region: null,
    annotate: null,
  })
  const coordMap = usecomputer.parseCoordMapOrThrow(beforeActionScreenshot.coordMap)
  const coordinate = Array.isArray(toolUse.input.coordinate)
    ? toolUse.input.coordinate
    : null
  const point = coordinate
    ? usecomputer.mapPointFromCoordMap({
        point: { x: coordinate[0] ?? 0, y: coordinate[1] ?? 0 },
        coordMap,
      })
    : null

  switch (toolUse.input.action) {
    case 'screenshot': {
      break
    }
    case 'left_click': {
      if (point) {
        await usecomputer.click({ point, button: 'left', count: 1 })
      }
      break
    }
    case 'double_click': {
      if (point) {
        await usecomputer.click({ point, button: 'left', count: 2 })
      }
      break
    }
    case 'mouse_move': {
      if (point) {
        await usecomputer.mouseMove(point)
      }
      break
    }
    case 'type': {
      if (typeof toolUse.input.text === 'string') {
        await usecomputer.typeText({ text: toolUse.input.text, delayMs: null })
      }
      break
    }
    case 'key': {
      if (typeof toolUse.input.text === 'string') {
        await usecomputer.press({ key: toolUse.input.text, count: 1, delayMs: null })
      }
      break
    }
    case 'scroll': {
      await usecomputer.scroll({
        direction: toolUse.input.scroll_direction === 'up' || toolUse.input.scroll_direction === 'down' || toolUse.input.scroll_direction === 'left' || toolUse.input.scroll_direction === 'right'
          ? toolUse.input.scroll_direction
          : 'down',
        amount: typeof toolUse.input.scroll_amount === 'number' ? toolUse.input.scroll_amount : 3,
        at: point,
      })
      break
    }
    default: {
      throw new Error(`Unsupported Claude computer action: ${String(toolUse.input.action)}`)
    }
  }

  const afterActionScreenshot = await usecomputer.screenshot({
    path: './tmp/claude-computer-tool.png',
    display: null,
    window: null,
    region: null,
    annotate: null,
  })
  const imageBase64 = await fs.promises.readFile(afterActionScreenshot.path, 'base64')
  const toolResult: BetaToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: imageBase64,
        },
      },
      {
        type: 'text',
        text: afterActionScreenshot.coordMap,
      },
    ],
  }
  // Append toolResult to the next user message in your agent loop.
}
```

## Screenshot scaling and coord-map

`usecomputer screenshot` always scales the output image so the longest edge is
at most `1568` px. This keeps screenshots in a model-friendly size for
computer-use agents.

Screenshot output includes:

- `desktopIndex` (display index used for capture)
- `coordMap` in the form `captureX,captureY,captureWidth,captureHeight,imageWidth,imageHeight`
- `hint` with usage text for coordinate mapping

Always pass the exact `--coord-map` value emitted by `usecomputer screenshot`
to pointer commands when you are clicking coordinates from that screenshot.
This maps screenshot-space coordinates back to real screen coordinates:

```bash
usecomputer screenshot ./shot.png --json
usecomputer click -x 400 -y 220 --coord-map "0,0,1600,900,1568,882"
usecomputer mouse move -x 100 -y 80 --coord-map "0,0,1600,900,1568,882"
```

To validate a target before clicking, use `debug-point`. It takes the same
coordinates and `--coord-map`, captures a fresh full-desktop screenshot, and
draws a red marker where the click would land. When `--coord-map` is present,
it captures that same region so the overlay matches the screenshot you are
targeting:

```bash
usecomputer debug-point -x 400 -y 220 --coord-map "0,0,1600,900,1568,882"
```

## Keyboard commands

### Type text

```bash
# Short text
usecomputer type "hello from usecomputer"

# Type from stdin (good for multiline or very long text)
cat ./notes.txt | usecomputer type --stdin --chunk-size 4000 --chunk-delay 15

# Simulate slower typing for apps that drop fast input
usecomputer type "hello" --delay 20
```

`--delay` is the per-character delay in milliseconds.

For very long text, prefer `--stdin` + `--chunk-size` so shell argument limits
and app input buffers are less likely to cause dropped characters.

### Press keys and shortcuts

```bash
# Single key
usecomputer press "enter"

# Chords
usecomputer press "cmd+s"
usecomputer press "cmd+shift+p"
usecomputer press "ctrl+s"

# Repeats
usecomputer press "down" --count 10 --delay 30
```

Modifier aliases: `cmd`/`command`/`meta`, `ctrl`/`control`, `alt`/`option`,
`shift`, `fn`.

Platform note:

- macOS: `cmd` maps to Command.
- Windows/Linux: `cmd` maps to Win/Super.
- For app shortcuts that should work on Windows/Linux too, prefer `ctrl+...`.

## Coordinate options

Commands that target coordinates accept `-x` and `-y` flags:

- `usecomputer click -x <n> -y <n>`
- `usecomputer hover -x <n> -y <n>`
- `usecomputer mouse move -x <n> -y <n>`

`mouse move` is optional before `click` when click coordinates are already
provided.

Legacy coordinate forms are also accepted where available.

## Display index options

For commands that accept `--display`, the index is 0-based:

- `0` = first display
- `1` = second display
- `2` = third display

Example:

```bash
usecomputer screenshot ./shot.png --display 0 --json
```
