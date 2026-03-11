// Public library helpers that expose the native automation commands as plain functions.

import { createBridge } from './bridge.js'
import type { NativeModule } from './native-lib.js'
import type {
  DisplayInfo,
  MouseButton,
  Point,
  ScreenshotResult,
  WindowInfo,
} from './types.js'

const bridge = createBridge()

export type NativeScreenshotInput = Parameters<NativeModule['screenshot']>[0]
export type NativeClickInput = Parameters<NativeModule['click']>[0]
export type NativeTypeTextInput = Parameters<NativeModule['typeText']>[0]
export type NativePressInput = Parameters<NativeModule['press']>[0]
export type NativeScrollInput = Parameters<NativeModule['scroll']>[0]
export type NativeDragInput = Parameters<NativeModule['drag']>[0]
export type NativeMouseButtonInput = Parameters<NativeModule['mouseDown']>[0]
export type NativeClipboardSetInput = Parameters<NativeModule['clipboardSet']>[0]

export async function screenshot(input: NativeScreenshotInput): Promise<ScreenshotResult> {
  return bridge.screenshot({
    path: input.path ?? undefined,
    display: input.display ?? undefined,
    window: input.window ?? undefined,
    region: input.region ?? undefined,
    annotate: input.annotate ?? undefined,
  })
}

export async function click(input: NativeClickInput): Promise<void> {
  return bridge.click({
    point: input.point,
    button: normalizeMouseButton(input.button),
    count: input.count ?? 1,
    modifiers: [],
  })
}

export async function typeText(input: NativeTypeTextInput): Promise<void> {
  return bridge.typeText({
    text: input.text,
    delayMs: input.delayMs ?? undefined,
  })
}

export async function press(input: NativePressInput): Promise<void> {
  return bridge.press({
    key: input.key,
    count: input.count ?? 1,
    delayMs: input.delayMs ?? undefined,
  })
}

export async function scroll(input: NativeScrollInput): Promise<void> {
  return bridge.scroll({
    direction: normalizeDirection(input.direction),
    amount: input.amount,
    at: input.at ?? undefined,
  })
}

export async function drag(input: NativeDragInput): Promise<void> {
  return bridge.drag({
    from: input.from,
    to: input.to,
    durationMs: input.durationMs ?? undefined,
    button: normalizeMouseButton(input.button),
  })
}

export async function hover(input: Point): Promise<void> {
  return bridge.hover(input)
}

export async function mouseMove(input: Point): Promise<void> {
  return bridge.mouseMove(input)
}

export async function mouseDown(input: NativeMouseButtonInput): Promise<void> {
  return bridge.mouseDown({
    button: normalizeMouseButton(input.button),
  })
}

export async function mouseUp(input: NativeMouseButtonInput): Promise<void> {
  return bridge.mouseUp({
    button: normalizeMouseButton(input.button),
  })
}

export async function mousePosition(): Promise<Point> {
  return bridge.mousePosition()
}

export async function displayList(): Promise<DisplayInfo[]> {
  return bridge.displayList()
}

export async function windowList(): Promise<WindowInfo[]> {
  return bridge.windowList()
}

export async function clipboardGet(): Promise<string> {
  return bridge.clipboardGet()
}

export async function clipboardSet(input: NativeClipboardSetInput): Promise<void> {
  return bridge.clipboardSet(input)
}

function normalizeMouseButton(input: MouseButton | null): MouseButton {
  return input ?? 'left'
}

function normalizeDirection(input: string): 'up' | 'down' | 'left' | 'right' {
  if (input === 'up' || input === 'down' || input === 'left' || input === 'right') {
    return input
  }

  throw new Error(`Invalid direction "${input}". Expected up, down, left, or right`)
}
