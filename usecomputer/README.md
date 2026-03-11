<!-- Purpose: npm package usage and install guide for usecomputer CLI. -->

# usecomputer

`usecomputer` is a macOS desktop automation CLI for AI agents.

It can move the mouse, click, drag, and query cursor position using native
Quartz events through a Zig N-API module.

Keyboard synthesis (`type` and `press`) is also available. The native backend
includes platform-specific key injection paths for macOS, Windows, and Linux
X11.

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
