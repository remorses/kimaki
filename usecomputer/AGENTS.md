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
