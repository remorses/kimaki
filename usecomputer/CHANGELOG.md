<!-- Purpose: track notable user-facing changes for npm releases. -->

# Changelog

All notable changes to `usecomputer` will be documented in this file.

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
