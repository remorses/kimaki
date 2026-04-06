---
name: usecomputer
description: >
  Desktop automation CLI for AI agents (macOS, Linux, Windows). Screenshot,
  click, type, scroll, drag with native Zig backend. Use this skill when
  automating desktop apps with computer use models (GPT-5.4, Claude). Covers
  the screenshot-action feedback loop, coord-map workflow, window-scoped
  screenshots, and system prompts for accurate clicking.
---

# usecomputer

Desktop automation CLI for AI agents. Works on macOS, Linux (X11), and
Windows. Takes screenshots, clicks, types, scrolls, drags using native
platform APIs through a Zig binary — no Node.js required at runtime.

## Always start with --help

**Always run `usecomputer --help` before using this tool.** The help output
is the source of truth for all commands, options, and examples. Never guess
command syntax — check help first.

When running help commands, read the **full untruncated output**. Never pipe
help through `head`, `tail`, or `sed` — you will miss critical options.

```bash
usecomputer --help
usecomputer screenshot --help
usecomputer click --help
usecomputer drag --help
```

## Install

```bash
npm install -g usecomputer
```

Requirements:

- **macOS** — Accessibility permission enabled for your terminal app
- **Linux** — X11 session with `DISPLAY` set (Wayland via XWayland works too)
- **Windows** — run in an interactive desktop session

## Core loop: screenshot -> act -> screenshot

Every computer use session follows a feedback loop:

```
screenshot -> send to model -> model returns action -> execute action -> screenshot again
     ^                                                                        |
     |________________________________________________________________________|
```

1. Take a screenshot with `usecomputer screenshot --json`
2. Send the screenshot image to the model
3. Model returns coordinates or an action (click, type, press, scroll)
4. Execute the action, passing the **exact `--coord-map`** from step 1
5. Take a fresh screenshot and go back to step 2

### Full cycle example

```bash
# 1. take screenshot (always use --json to get coordMap)
usecomputer screenshot ./tmp/screen.png --json
# output: {"path":"./tmp/screen.png","coordMap":"0,0,3440,1440,1568,657",...}

# 2. send ./tmp/screen.png to the model
# 3. model says: "click the Save button at x=740 y=320"

# 4. click using the coord-map from the screenshot output
usecomputer click -x 740 -y 320 --coord-map "0,0,3440,1440,1568,657"

# 5. take a fresh screenshot to see what happened
usecomputer screenshot ./tmp/screen.png --json
# ... repeat
```

**Never skip `--coord-map`.** Screenshots are scaled (longest edge <= 1568px).
The coord-map maps screenshot-space pixels back to real desktop coordinates.
Without it, clicks land in wrong positions.

**Always take a fresh screenshot after each action.** The UI changes after
every click, scroll, or keystroke — menus open, pages scroll, dialogs appear.
Never reuse a stale screenshot.

## Window-scoped screenshots

Full-desktop screenshots include everything — dock, menu bar, background
windows. For better accuracy, capture only the target application window.
This produces a smaller, more focused image the model can reason about.

### Step 1: find the window ID

```bash
usecomputer window list --json
```

This returns an array of visible windows with their `id`, `ownerName`,
`title`, position, and size. Find the window you want to target.

### Step 2: screenshot that window

```bash
usecomputer screenshot ./tmp/app.png --window 12345 --json
# output: {"path":"./tmp/app.png","coordMap":"200,100,1200,800,1568,1045",...}
```

The coord-map in the output is scoped to that window's region on screen.

### Step 3: act using the coord-map

```bash
# model analyzes ./tmp/app.png and says click at x=400 y=220
usecomputer click -x 400 -y 220 --coord-map "200,100,1200,800,1568,1045"
```

The coord-map handles the translation from the window screenshot's pixel
space back to the correct desktop coordinates. The click lands on the
right spot even though the screenshot only showed one window.

### Region screenshots

You can also capture an arbitrary rectangle of the screen:

```bash
usecomputer screenshot ./tmp/region.png --region "100,100,800,600" --json
```

The coord-map works the same way — pass it to subsequent pointer commands.

## Coord-map explained

The coord-map is 6 comma-separated values emitted by every screenshot:

```
captureX,captureY,captureWidth,captureHeight,imageWidth,imageHeight
```

- **captureX, captureY** — top-left corner of the captured region in desktop
  coordinates
- **captureWidth, captureHeight** — size of the captured region in desktop
  pixels
- **imageWidth, imageHeight** — size of the output PNG (after scaling)

When you pass `--coord-map` to `click`, `hover`, `drag`, or `mouse move`,
the command maps your screenshot-space x,y coordinates back to the real
desktop position using these values.

## Validating coordinates with debug-point

Before clicking, you can validate where the click would land:

```bash
usecomputer debug-point -x 400 -y 220 --coord-map "0,0,1600,900,1568,882"
```

This captures a screenshot and draws a red marker at the mapped coordinate.
Send the output image back to the model so it can see if the target is
correct and adjust if needed.

## Quick examples

```bash
# screenshot the primary display
usecomputer screenshot ./tmp/screen.png --json

# screenshot a specific display (0-indexed)
usecomputer screenshot ./tmp/screen.png --display 1 --json

# click at screenshot coordinates
usecomputer click -x 600 -y 400 --coord-map "0,0,1600,900,1568,882"

# right-click
usecomputer click -x 600 -y 400 --button right --coord-map "..."

# double-click
usecomputer click -x 600 -y 400 --count 2 --coord-map "..."

# click with modifier keys held
usecomputer click -x 600 -y 400 --modifier option --coord-map "..."
usecomputer click -x 600 -y 400 --modifier cmd --modifier shift --coord-map "..."

# type text
usecomputer type "hello from usecomputer"

# type long text from stdin
cat ./notes.txt | usecomputer type --stdin --chunk-size 4000 --chunk-delay 15

# press a key
usecomputer press "enter"

# press a shortcut
usecomputer press "cmd+s"
usecomputer press "cmd+shift+p"

# press with repeat
usecomputer press "down" --count 10 --delay 30

# scroll
usecomputer scroll down 5
usecomputer scroll up 3
usecomputer scroll down 5 --at "400,300"

# drag (straight line)
usecomputer drag 100,200 500,600

# drag (curved path with bezier control point)
usecomputer drag 100,200 500,600 300,50

# drag with coord-map
usecomputer drag 100,200 500,600 --coord-map "..."

# mouse position
usecomputer mouse position --json

# list displays
usecomputer display list --json

# list windows
usecomputer window list --json

# list desktops with windows
usecomputer desktop list --windows --json
```

## System prompt tips for accurate clicking

When using GPT-5.4 or Claude for computer use, keep the system prompt short
and task-focused. Verbose system prompts reduce click accuracy.

**GPT-5.4:** Use `detail: "original"` on screenshot inputs. This is the
single most important setting for click accuracy. Avoid `detail: "high"` or
`detail: "low"`.

**Claude:** Use the `computer_20251124` tool type with `display_width_px` and
`display_height_px` matching the screenshot dimensions from the coord-map
output.

**General rules:**

- Take a fresh screenshot after every action
- Always pass the coord-map from the screenshot the model analyzed
- If clicks land in wrong spots, use `debug-point` to diagnose
- If the model returns coordinates outside screenshot dimensions, re-send
  the screenshot and remind it of the image size

## Troubleshooting

1. **Clicks land in wrong position** — you probably forgot `--coord-map`,
   or you are passing a coord-map from a different screenshot than the one
   the model analyzed. Always use the coord-map from the most recent screenshot.

2. **Retina displays** — usecomputer handles scaling internally via
   coord-map. Do not try to manually account for display scaling.

3. **Stale screenshots** — the most common source of bugs. Always take a
   fresh screenshot after each action. The UI changes constantly.

4. **Permission errors on macOS** — enable Accessibility permission for
   your terminal app in System Settings > Privacy & Security > Accessibility.

5. **X11 errors on Linux** — ensure `DISPLAY` is set. For XWayland, screenshot
   falls back to XGetImage automatically if XShm fails.
