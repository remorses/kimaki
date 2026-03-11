// ESM native loader for the usecomputer Zig addon using createRequire.

import os from 'node:os'
import { createRequire } from 'node:module'
import type {
  MouseButton,
  NativeCommandResult,
  NativeDataResult,
  Point,
  Region,
} from './types.js'

const require = createRequire(import.meta.url)

export interface NativeModule {
  screenshot(input: { path: string | null; display: number | null; region: Region | null; annotate: boolean | null }): NativeCommandResult
  click(input: { point: Point; button: MouseButton | null; count: number | null }): NativeCommandResult
  typeText(input: { text: string; delayMs: number | null }): NativeCommandResult
  press(input: { key: string; count: number | null; delayMs: number | null }): NativeCommandResult
  scroll(input: { direction: string; amount: number; at: Point | null }): NativeCommandResult
  drag(input: { from: Point; to: Point; durationMs: number | null; button: MouseButton | null }): NativeCommandResult
  hover(input: Point): NativeCommandResult
  mouseMove(input: Point): NativeCommandResult
  mouseDown(input: { button: MouseButton | null }): NativeCommandResult
  mouseUp(input: { button: MouseButton | null }): NativeCommandResult
  mousePosition(): NativeDataResult<Point>
  displayList(): NativeCommandResult
  clipboardGet(): NativeDataResult<string>
  clipboardSet(input: { text: string }): NativeCommandResult
}

function loadCandidate(path: string): NativeModule | null {
  try {
    return require(path) as NativeModule
  } catch {
    return null
  }
}

function loadNativeModule(): NativeModule | null {
  const dev = loadCandidate('../zig-out/lib/usecomputer.node')
  if (dev) {
    return dev
  }

  const platform = os.platform()
  const arch = os.arch()
  const target = `${platform}-${arch}`

  const packaged = loadCandidate(`../dist/${target}/usecomputer.node`)
  if (packaged) {
    return packaged
  }

  return null
}

export const native = loadNativeModule()
