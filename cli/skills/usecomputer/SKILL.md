---
name: usecomputer
description: macOS desktop automation CLI for AI agents. Screenshot, click, type, scroll, drag with native Zig backend. Use this skill when automating desktop apps with computer use models (GPT-5.4, Claude). Covers coord-map workflow, system prompts for accurate clicking, and the screenshot-action loop.
---

# usecomputer

macOS desktop automation CLI. Takes screenshots, clicks, types, scrolls, drags
using native Quartz events through a Zig N-API module.

## Install

```bash
npm install -g usecomputer
```

Requires macOS + Accessibility permission for your terminal app.

## Core workflow: screenshot -> click -> screenshot

Every computer use loop follows this pattern:

1. Take a screenshot with `usecomputer screenshot`
2. Send the screenshot to the model
3. Model returns coordinates to click
4. Click using the **exact coord-map** from step 1
5. Take another screenshot and repeat

```bash
# 1. screenshot (always use --json to get coordMap)
usecomputer screenshot ./tmp/screen.png --json

# 2. model says "click at x=400 y=220"

# 3. click using coord-map from screenshot output
usecomputer click -x 400 -y 220 --coord-map "0,0,1600,900,1568,882"

# 4. validate before clicking (optional but recommended)
usecomputer debug-point -x 400 -y 220 --coord-map "0,0,1600,900,1568,882"
```

**CRITICAL: always pass `--coord-map` from the screenshot output to click.**
Screenshots are scaled (longest edge <= 1568px). The coord-map maps
screenshot-space pixels back to real screen coordinates. Without it, clicks
land in wrong positions.

## System prompt for accurate clicking

When using GPT-5.4 or Claude for computer use, the system prompt / instructions
matter for click accuracy. Keep instructions short and task-focused.

### GPT-5.4 native computer tool

Use `detail: "original"` on screenshot inputs. This is the single most
important setting for click accuracy.

```ts
// sending screenshot back to the model
{
  type: "computer_call_output",
  call_id: computerCall.call_id,
  output: {
    type: "computer_screenshot",
    image_url: `data:image/png;base64,${screenshotBase64}`,
    detail: "original",  // CRITICAL for click accuracy
  },
}
```

Recommended resolutions when downscaling: **1440x900** and **1600x900**.
usecomputer already scales to max 1568px longest edge which is in this range.

Avoid `detail: "high"` or `detail: "low"` for computer use tasks.

### System prompt template (native computer tool)

```
You are controlling a desktop application through the built-in computer tool.
Use the computer tool for all UI interaction.
Use only the operator prompt as the source of truth.
<task-specific instruction here>
Reply briefly once the task is complete.
```

### System prompt template (code execution / Playwright REPL)

```
You are operating a persistent Playwright browser session.
You must use the exec_js tool before you answer.
The app is already open at {url}.
Use only the operator prompt as the source of truth.
<task-specific instruction here>
Reply briefly once done.
```

### Key prompt patterns from OpenAI docs

These XML blocks can be added to agent instructions for better reliability:

```xml
<tool_persistence_rules>
- Use tools whenever they materially improve correctness.
- Do not stop early when another tool call would improve completeness.
- Keep calling tools until the task is complete and verification passes.
- If a tool returns empty or partial results, retry with a different strategy.
</tool_persistence_rules>
```

```xml
<verification_loop>
Before finalizing:
- Check correctness: does the output satisfy every requirement?
- Check formatting: does the output match the requested schema?
- Check safety: if the next step has external side effects, ask permission.
</verification_loop>
```

```xml
<completeness_contract>
- Treat the task as incomplete until all requested items are covered.
- Keep an internal checklist of required deliverables.
- If any item is blocked by missing data, mark it [blocked] and state what is missing.
</completeness_contract>
```

## Commands reference

### screenshot

```bash
usecomputer screenshot [path] --json
usecomputer screenshot ./shot.png --display 0 --json
usecomputer screenshot ./shot.png --region "100,100,800,600" --json
usecomputer screenshot ./shot.png --window 12345 --json
```

JSON output includes `path`, `coordMap`, `hint`, `desktopIndex`, `imageWidth`,
`imageHeight`. Always use `--json` and always pass the `coordMap` value to
subsequent click/hover/drag commands.

### click

```bash
usecomputer click -x 400 -y 220 --coord-map "0,0,1600,900,1568,882"
usecomputer click -x 400 -y 220 --button right --coord-map "..."
usecomputer click -x 400 -y 220 --count 2 --coord-map "..."  # double click
```

`-x` and `-y` are **screenshot-space pixels** when using `--coord-map`.

### debug-point

Validate coordinates before clicking. Captures a screenshot and draws a red
marker where the click would land:

```bash
usecomputer debug-point -x 400 -y 220 --coord-map "0,0,1600,900,1568,882"
usecomputer debug-point -x 400 -y 220 --coord-map "..." --json
```

Use this when clicks are landing in wrong positions. Send the output image
to the model so it can see where the marker is and adjust.

### type

```bash
usecomputer type "hello"
usecomputer type "hello" --delay 20          # per-char delay ms
cat file.txt | usecomputer type --stdin --chunk-size 4000 --chunk-delay 15
```

### press

```bash
usecomputer press "enter"
usecomputer press "cmd+s"
usecomputer press "cmd+shift+p"
usecomputer press "down" --count 10 --delay 30
```

Modifier aliases: `cmd`/`command`/`meta`, `ctrl`/`control`, `alt`/`option`,
`shift`, `fn`.

### scroll

```bash
usecomputer scroll down 5
usecomputer scroll up 3
usecomputer scroll down 5 --at "400,300"   # scroll at specific position
```

### drag

```bash
usecomputer drag "100,200" "400,500"
usecomputer drag "100,200" "400,500" --coord-map "..."
usecomputer drag "100,200" "400,500" --duration 500
```

### mouse

```bash
usecomputer mouse position --json
usecomputer mouse move -x 500 -y 500
usecomputer mouse move -x 500 -y 500 --coord-map "..."
usecomputer mouse down --button left
usecomputer mouse up --button left
```

### hover

```bash
usecomputer hover -x 300 -y 200 --coord-map "..."
```

### display / desktop

```bash
usecomputer display list --json
usecomputer desktop list --json
usecomputer desktop list --windows --json
```

### clipboard

```bash
usecomputer clipboard get
usecomputer clipboard set "copied text"
```

### window

```bash
usecomputer window list --json
```

## Library usage (Node.js)

usecomputer exports all commands as functions:

```ts
import * as usecomputer from 'usecomputer'

const screenshot = await usecomputer.screenshot({
  path: './tmp/shot.png',
  display: null,
  window: null,
  region: null,
  annotate: null,
})

// map model coordinates to real screen coordinates
const coordMap = usecomputer.parseCoordMapOrThrow(screenshot.coordMap)
const point = usecomputer.mapPointFromCoordMap({
  point: { x: 400, y: 220 },
  coordMap,
})

await usecomputer.click({ point, button: 'left', count: 1 })
```

## OpenAI computer tool integration

```ts
import fs from 'node:fs'
import * as usecomputer from 'usecomputer'

async function captureScreenshot() {
  const screenshot = await usecomputer.screenshot({
    path: './tmp/computer-tool.png',
    display: null, window: null, region: null, annotate: null,
  })
  return {
    screenshot,
    imageBase64: await fs.promises.readFile(screenshot.path, 'base64'),
  }
}

async function executeAction(action, coordMapStr) {
  const coordMap = usecomputer.parseCoordMapOrThrow(coordMapStr)
  const mapPoint = (x, y) =>
    usecomputer.mapPointFromCoordMap({ point: { x, y }, coordMap })

  switch (action.type) {
    case 'click':
      await usecomputer.click({
        point: mapPoint(action.x, action.y),
        button: action.button ?? 'left',
        count: 1,
      })
      break
    case 'double_click':
      await usecomputer.click({
        point: mapPoint(action.x, action.y),
        button: action.button ?? 'left',
        count: 2,
      })
      break
    case 'type':
      await usecomputer.typeText({ text: action.text, delayMs: null })
      break
    case 'keypress':
      await usecomputer.press({
        key: action.keys.join('+'),
        count: 1,
        delayMs: null,
      })
      break
    case 'scroll':
      await usecomputer.scroll({
        direction: action.scrollY < 0 ? 'up' : 'down',
        amount: Math.abs(action.scrollY ?? 0),
        at: typeof action.x === 'number'
          ? mapPoint(action.x, action.y)
          : null,
      })
      break
  }
}
```

## Troubleshooting click accuracy

1. **Always pass `--coord-map`** from the screenshot that the model analyzed.
   Without it, coordinates are treated as raw screen coordinates.

2. **Use `debug-point`** to visually verify where a click will land before
   sending the real click. Send the debug image back to the model.

3. **Retina displays**: usecomputer handles scaling internally via coord-map.
   But if you bypass coord-map and use raw pyautogui-style coordinates, you
   need to account for display scaling yourself.

4. **Model sees wrong resolution**: if the model returns coordinates outside
   the screenshot dimensions, it may be hallucinating. Re-send the screenshot
   with `detail: "original"` and remind it of the image dimensions.

5. **Stale screenshots**: always take a fresh screenshot after each action.
   The UI may have changed (menus opened, pages scrolled, dialogs appeared).
