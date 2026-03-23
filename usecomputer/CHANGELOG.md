<!-- Purpose: track notable user-facing changes for npm releases. -->

# Changelog

All notable changes to `usecomputer` will be documented in this file.

## 0.1.1

1. **Fixed Linux native builds** — standalone executable now links libc correctly on Linux, fixing "C allocator is only available when linking against libc" errors.
2. **Fixed native host builds** — build script now omits `-Dtarget` when building for the host platform so Zig finds system libraries (X11, libpng, etc).

## 0.1.0

1. **Standalone executable** — `usecomputer` now ships as a self-contained binary.
   Install once and run anywhere without needing Node.js at runtime:

   ```bash
   npm install -g usecomputer
   usecomputer screenshot ./shot.png --json
   ```

2. **Linux X11 screenshot support** — capture screens on Linux desktops via XShm
   (with automatic fallback to XGetImage on XWayland). Returns the same JSON
   output shape as macOS:

   ```bash
   usecomputer screenshot ./shot.png --json
   ```

3. **Screenshot coord-map and scaling** — screenshots are scaled so the longest edge
   is at most 1568 px (model-friendly size). Output includes a `coordMap` field
   for accurate pointer remapping:

   ```bash
   usecomputer screenshot ./shot.png --json
   # use the emitted coord-map for all subsequent pointer commands
   usecomputer click -x 400 -y 220 --coord-map "0,0,1600,900,1568,882"
   ```

4. **New `debug-point` command** — validate a click target before clicking. Captures
   a screenshot and draws a red marker at the mapped coordinate:

   ```bash
   usecomputer debug-point -x 400 -y 220 --coord-map "0,0,1600,900,1568,882"
   ```

5. **Keyboard synthesis** — new `type` and `press` commands for text input and key
   chords:

   ```bash
   usecomputer type "hello from usecomputer"
   usecomputer press "cmd+s"
   usecomputer press "down" --count 10 --delay 30
   cat ./notes.txt | usecomputer type --stdin --chunk-size 4000
   ```

6. **Native scroll support** — scroll in any direction at any position:

   ```bash
   usecomputer scroll --direction down --amount 5
   usecomputer scroll --direction up --amount 3 -x 800 -y 400
   ```

7. **Library exports** — import `usecomputer` as a Node.js library to reuse all
   commands in your own agent harness:

   ```ts
   import * as usecomputer from 'usecomputer'

   const shot = await usecomputer.screenshot({ path: './shot.png', display: null, window: null, region: null, annotate: null })
   const coordMap = usecomputer.parseCoordMapOrThrow(shot.coordMap)
   await usecomputer.click({ point: usecomputer.mapPointFromCoordMap({ point: { x: 400, y: 220 }, coordMap }), button: 'left', count: 1 })
   ```

8. **OpenAI and Anthropic computer-use examples** — README now includes full
   agentic loop examples for both providers showing screenshot → action → result
   cycles.

## 0.0.3

- Implement real screenshot capture + PNG file writing on macOS.
- Screenshot path handling now uses the requested output path reliably.
- Unimplemented commands now return explicit `TODO not implemented: ...` errors.
- Clarify `--display` index behavior as 0-based in help/docs.

## 0.0.2

- Publish macOS native binaries for both `darwin-arm64` and `darwin-x64`.
- Add package metadata/docs for npm distribution.
- Improve CLI coordinate input with `-x` / `-y` flags.

## 0.0.1

- Initial npm package release for macOS.
- Native Zig + Quartz mouse actions:
  - `click`
  - `mouse move`
  - `mouse down`
  - `mouse up`
  - `mouse position`
  - `hover`
  - `drag`
- CLI coordinates improved with `-x` and `-y` flags.
