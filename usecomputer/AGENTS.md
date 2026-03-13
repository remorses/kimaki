<!-- Purpose: implementation references and guardrails for usecomputer maintainers. -->

# usecomputer agent notes

## Goal

`usecomputer` is a macOS desktop automation CLI for AI agents.
The package should expose stable, scriptable computer-use commands (mouse,
keyboard, screenshot, clipboard, window actions) backed by a native Zig N-API
module, with behavior aligned to CUA command semantics.

## Source of truth for command behavior

CUA references are the primary behavioral source of truth for command semantics
and edge cases. When implementing or adjusting command behavior, always compare
against these files first:

- CUA macOS handler (core command behavior):
  https://github.com/trycua/cua/blob/main/libs/python/computer-server/computer_server/handlers/macos.py
- CUA server command routing and payload shapes:
  https://github.com/trycua/cua/blob/main/libs/python/computer-server/computer_server/main.py

Implementation note: this package does not use `pyobjc`. We implement the same
command behavior using Zig + native macOS APIs.

## Native implementation dependencies

- zig-objc (Objective-C runtime bindings used by this package):
  https://github.com/mitchellh/zig-objc
- napigen (N-API glue used by Zig module exports):
  https://github.com/cztomsik/napigen

## Cross-platform input backend reference

For mouse/keyboard parity across macOS, Windows, and Linux, use `pynput` as a
behavior and backend reference (do not copy code directly; keep implementation
native in Zig):

- Repository: https://github.com/moses-palmer/pynput
- Mouse base API (undefined unit semantics for scroll):
  https://github.com/moses-palmer/pynput/blob/master/lib/pynput/mouse/_base.py
- macOS backend (`CGEventCreateScrollWheelEvent`):
  https://github.com/moses-palmer/pynput/blob/master/lib/pynput/mouse/_darwin.py
- Windows backend (`SendInput` wheel/hwheel, `WHEEL_DELTA`):
  https://github.com/moses-palmer/pynput/blob/master/lib/pynput/mouse/_win32.py
- X11 backend (button-based scroll 4/5/6/7 with XTest):
  https://github.com/moses-palmer/pynput/blob/master/lib/pynput/mouse/_xorg.py

## Display, spaces, and app enumeration reference

Use `stoffeastrom/yabai.zig` as a practical Zig reference for Objective-C runtime
calls, display metadata, SkyLight spaces, and running app enumeration.

- Repository: https://github.com/stoffeastrom/yabai.zig
- `NSScreen` + `NSScreenNumber` mapping example:
  https://github.com/stoffeastrom/yabai.zig/blob/main/src/platform/workspace.zig
- Spaces traversal via `SLSCopyManagedDisplaySpaces`:
  https://github.com/stoffeastrom/yabai.zig/blob/main/src/state/Spaces.zig
- SkyLight symbol loading and function table:
  https://github.com/stoffeastrom/yabai.zig/blob/main/src/platform/skylight.zig

Use this reference when implementing `display list`, desktop/space indexing,
and features that need running app queries from `NSWorkspace` /
`NSRunningApplication`.

## Keyboard synthesis references (Zig)

Use skhd.zig as implementation inspiration for keyboard handling and synthesis.

- Maintained fork with Zig 0.15 migration work:
  https://github.com/cimandef/skhd.zig
- Upstream fork reference:
  https://github.com/jackielii/skhd.zig

Focus files for keyboard implementation patterns:

- `src/synthesize.zig` (key combo + text synthesis using CG events)
- `src/Keycodes.zig` (modifier parsing and keyboard-layout-aware keycode mapping)
- `src/c.zig` (Carbon / CoreServices / IOKit imports used by keyboard paths)

Important APIs shown in these files:

- `CGEventCreateKeyboardEvent`
- `CGEventKeyboardSetUnicodeString`
- `CGEventPost`
- `TISCopyCurrentASCIICapableKeyboardLayoutInputSource`
- `UCKeyTranslate`

## Linux VM testing

usecomputer is tested on a real Linux VM (UTM on macOS, Ubuntu aarch64 guest).
The VM uses `qemu-guest-agent` for command execution — there is no SSH or shared
folders. All file transfer goes through base64-encoded tar archives.

Everything is in one unified script: `pnpm vm <subcommand>`. Run
`pnpm vm --help` to see all subcommands and options. `HOME` is set
automatically on every command — no need to export it manually.

### VM subcommands

| Command | Description |
|---------|-------------|
| `pnpm vm exec -- '<command>'` | Run a shell command inside the VM |
| `pnpm vm exec -- --x11 '<command>'` | Same but also set DISPLAY/XAUTHORITY |
| `pnpm vm sync` | Sync git-tracked files to the VM |
| `pnpm vm test` | Sync, build, typecheck, run tests |
| `pnpm vm test --setup` | Same but install system deps first |

### Running commands manually

```bash
# Build zig module
pnpm vm exec -- 'cd /root/usecomputer && zig build'

# Run tests with X11 access
pnpm vm exec -- --x11 'cd /root/usecomputer && npx vitest --run'

# Install npm deps (needed after first sync)
pnpm vm exec -- 'cd /root/usecomputer && pnpm install --filter usecomputer'
```

### Full test run (first time)

```bash
pnpm vm test --setup
```

This installs all system dependencies, syncs files, builds, typechecks, and
runs the test suite. Subsequent runs can skip `--setup`:

```bash
pnpm vm test
```

### Linux build caveats

- **zig_objc** is marked as a lazy dependency — only fetched on macOS, skipped
  on Linux. If zig fails with `AppDataDirUnavailable`, ensure `HOME` is set.
- **XDestroyImage** and **XGetPixel** are C macros that zig can't translate.
  The code calls the function pointers directly instead
  (`image.*.f.destroy_image.?()`, `image.*.f.get_pixel.?()`).
- **XShm** fails on XWayland with BadAccess. The screenshot code installs a
  custom X error handler and falls back to XGetImage. If that also fails
  (BadMatch on XWayland root window), screenshot returns an error gracefully
  instead of crashing.
- **c_ulong** is 64-bit on aarch64-linux, so bit shift counts from `@ctz`
  need explicit `@intCast` to `Log2Int(c_ulong)`.

## Build and distribution reference

Use ghostty-opentui as a reference for native packaging patterns
(build.zig wiring, distribution targets, package metadata, CI expectations):

- Repository: https://github.com/remorses/ghostty-opentui
- Build script reference: https://github.com/remorses/ghostty-opentui/blob/main/build.zig
- Cross-target build script reference:
  https://github.com/remorses/ghostty-opentui/blob/main/scripts/build.ts
- Package/distribution reference:
  https://github.com/remorses/ghostty-opentui/blob/main/package.json

## Manual testing safety

When manually testing click commands, do not use `20,20` or other top-left
coordinates because that can close windows or trigger OS UI controls.

Prefer safer coordinates, for example:

- `mouse position --json` then click at `x+30,y+30`, or
- explicit coordinates in a safe central area of the active screen.

## Running CLI locally

Use the local source CLI from this package directory:

```bash
pnpm tsx src/cli.ts --help
```

Common local flows:

```bash
# Build native module first when changing Zig code
pnpm build:native:macos

# Mouse position
pnpm tsx src/cli.ts mouse position --json

# Click at coordinates
pnpm tsx src/cli.ts click -x 600 -y 500 --button left --count 1

# Screenshot to a path
pnpm tsx src/cli.ts screenshot "./tmp/local-shot.png" --json
```

## Keyboard command examples

Keyboard APIs should follow CUA-compatible semantics. Example CLI usage:

```bash
# Type plain text
pnpm tsx src/cli.ts type "hello from usecomputer"

# Press one key
pnpm tsx src/cli.ts press "enter"

# Press a two-key shortcut (example: cmd+s)
pnpm tsx src/cli.ts press "cmd+s"

# Press another two-key shortcut (example: alt+tab)
pnpm tsx src/cli.ts press "alt+tab"
```

Note: if keyboard commands are not implemented yet in native Zig, commands
return `TODO not implemented` until that command is ported.
