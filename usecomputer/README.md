<!-- Purpose: npm package usage and install guide for usecomputer CLI. -->

# usecomputer

`usecomputer` is a macOS desktop automation CLI for AI agents.

It can move the mouse, click, drag, and query cursor position using native
Quartz events through a Zig N-API module.

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
```

## Coordinate options

Commands that target coordinates accept `-x` and `-y` flags:

- `usecomputer click -x <n> -y <n>`
- `usecomputer hover -x <n> -y <n>`
- `usecomputer mouse move -x <n> -y <n>`

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
