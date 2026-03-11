// Native bridge that maps typed TS calls to direct Zig N-API methods.

import { native, type NativeModule } from './native-lib.js'
import { z } from 'zod'
import type {
  ClickInput,
  DisplayInfo,
  DragInput,
  NativeCommandResult,
  NativeDataResult,
  Point,
  PressInput,
  Region,
  ScreenshotInput,
  ScreenshotResult,
  ScrollInput,
  TypeInput,
  UseComputerBridge,
} from './types.js'

const displayInfoSchema = z.object({
  id: z.number(),
  index: z.number(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  scale: z.number(),
  isPrimary: z.boolean(),
})

const displayListSchema = z.array(displayInfoSchema)

const unavailableError =
  'Native backend is unavailable. Build it with `pnpm build:native` or `zig build` in usecomputer/.'

class NativeBridgeError extends Error {
  readonly code?: string
  readonly command?: string

  constructor({
    message,
    code,
    command,
  }: {
    message: string
    code?: string
    command?: string
  }) {
    super(message)
    this.name = 'NativeBridgeError'
    this.code = code
    this.command = command
  }
}

function unwrapCommand({
  result,
  fallbackCommand,
}: {
  result: NativeCommandResult
  fallbackCommand: string
}): Error | null {
  if (result.ok) {
    return null
  }
  const message = result.error?.message || `Native command failed: ${fallbackCommand}`
  return new NativeBridgeError({
    message,
    code: result.error?.code,
    command: result.error?.command || fallbackCommand,
  })
}

function unwrapData<T>({
  result,
  fallbackCommand,
}: {
  result: NativeDataResult<T>
  fallbackCommand: string
}): Error | T {
  if (result.ok) {
    if (result.data === undefined) {
      return new NativeBridgeError({
        message: `Native command returned no data: ${fallbackCommand}`,
        command: fallbackCommand,
      })
    }
    return result.data
  }
  return new NativeBridgeError({
    message: result.error?.message || `Native command failed: ${fallbackCommand}`,
    code: result.error?.code,
    command: result.error?.command || fallbackCommand,
  })
}

function unavailableBridge(): UseComputerBridge {
  const fail = async (): Promise<never> => {
    throw new Error(unavailableError)
  }

  return {
    screenshot: fail,
    click: fail,
    typeText: fail,
    press: fail,
    scroll: fail,
    drag: fail,
    hover: fail,
    mouseMove: fail,
    mouseDown: fail,
    mouseUp: fail,
    mousePosition: fail,
    displayList: fail,
    clipboardGet: fail,
    clipboardSet: fail,
  }
}

export function createBridgeFromNative({ nativeModule }: { nativeModule: NativeModule | null }): UseComputerBridge {
  if (!nativeModule) {
    return unavailableBridge()
  }

  return {
    async screenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
      const nativeInput: { path: string | null; display: number | null; region: Region | null; annotate: boolean | null } = {
        path: input.path ?? null,
        display: input.display ?? null,
        region: input.region ?? null,
        annotate: input.annotate ?? null,
      }

      const result = unwrapData({
        result: nativeModule.screenshot(nativeInput),
        fallbackCommand: 'screenshot',
      })
      if (result instanceof Error) {
        throw result
      }
      const coordMap = [
        result.captureX,
        result.captureY,
        result.captureWidth,
        result.captureHeight,
        result.imageWidth,
        result.imageHeight,
      ].join(',')
      const hint = 'use --coord-map coordmap to use command like click, move etc on the coordinate system of this screenshot'

      return {
        path: result.path,
        desktopIndex: result.desktopIndex,
        captureX: result.captureX,
        captureY: result.captureY,
        captureWidth: result.captureWidth,
        captureHeight: result.captureHeight,
        imageWidth: result.imageWidth,
        imageHeight: result.imageHeight,
        coordMap,
        hint,
      }
    },
    async click(input: ClickInput): Promise<void> {
      const nativeInput: { point: Point; button: 'left' | 'right' | 'middle' | null; count: number | null } = {
        point: input.point,
        button: input.button ?? null,
        count: input.count ?? null,
      }

      const result = nativeModule.click(nativeInput)
      const maybeError = unwrapCommand({ result, fallbackCommand: 'click' })
      if (maybeError instanceof Error) {
        throw maybeError
      }
    },
    async typeText(input: TypeInput): Promise<void> {
      const nativeInput: { text: string; delayMs: number | null } = {
        text: input.text,
        delayMs: input.delayMs ?? null,
      }

      const result = nativeModule.typeText(nativeInput)
      const maybeError = unwrapCommand({ result, fallbackCommand: 'typeText' })
      if (maybeError instanceof Error) {
        throw maybeError
      }
    },
    async press(input: PressInput): Promise<void> {
      const nativeInput: { key: string; count: number | null; delayMs: number | null } = {
        key: input.key,
        count: input.count ?? null,
        delayMs: input.delayMs ?? null,
      }

      const result = nativeModule.press(nativeInput)
      const maybeError = unwrapCommand({ result, fallbackCommand: 'press' })
      if (maybeError instanceof Error) {
        throw maybeError
      }
    },
    async scroll(input: ScrollInput): Promise<void> {
      const nativeInput: { direction: string; amount: number; at: Point | null } = {
        direction: input.direction,
        amount: input.amount,
        at: input.at ?? null,
      }

      const result = nativeModule.scroll(nativeInput)
      const maybeError = unwrapCommand({ result, fallbackCommand: 'scroll' })
      if (maybeError instanceof Error) {
        throw maybeError
      }
    },
    async drag(input: DragInput): Promise<void> {
      const nativeInput: {
        from: Point
        to: Point
        durationMs: number | null
        button: 'left' | 'right' | 'middle' | null
      } = {
        from: input.from,
        to: input.to,
        durationMs: input.durationMs ?? null,
        button: input.button ?? null,
      }

      const result = nativeModule.drag(nativeInput)
      const maybeError = unwrapCommand({ result, fallbackCommand: 'drag' })
      if (maybeError instanceof Error) {
        throw maybeError
      }
    },
    async hover(input: Point): Promise<void> {
      const result = nativeModule.hover(input)
      const maybeError = unwrapCommand({ result, fallbackCommand: 'hover' })
      if (maybeError instanceof Error) {
        throw maybeError
      }
    },
    async mouseMove(input: Point): Promise<void> {
      const result = nativeModule.mouseMove(input)
      const maybeError = unwrapCommand({ result, fallbackCommand: 'mouseMove' })
      if (maybeError instanceof Error) {
        throw maybeError
      }
    },
    async mouseDown(input: { button: 'left' | 'right' | 'middle' }): Promise<void> {
      const result = nativeModule.mouseDown({ button: input.button ?? null })
      const maybeError = unwrapCommand({ result, fallbackCommand: 'mouseDown' })
      if (maybeError instanceof Error) {
        throw maybeError
      }
    },
    async mouseUp(input: { button: 'left' | 'right' | 'middle' }): Promise<void> {
      const result = nativeModule.mouseUp({ button: input.button ?? null })
      const maybeError = unwrapCommand({ result, fallbackCommand: 'mouseUp' })
      if (maybeError instanceof Error) {
        throw maybeError
      }
    },
    async mousePosition(): Promise<Point> {
      const result = unwrapData({
        result: nativeModule.mousePosition(),
        fallbackCommand: 'mousePosition',
      })
      if (result instanceof Error) {
        throw result
      }
      return result
    },
    async displayList(): Promise<DisplayInfo[]> {
      const payload = unwrapData({
        result: nativeModule.displayList(),
        fallbackCommand: 'displayList',
      })
      if (payload instanceof Error) {
        throw payload
      }

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(payload)
      } catch (e) {
        throw new NativeBridgeError({
          message: 'Native displayList returned invalid JSON',
          command: 'displayList',
          code: 'INVALID_NATIVE_JSON',
        })
      }

      const parsed = displayListSchema.safeParse(parsedJson)
      if (!parsed.success) {
        throw new NativeBridgeError({
          message: 'Native displayList returned invalid payload shape',
          command: 'displayList',
          code: 'INVALID_NATIVE_PAYLOAD',
        })
      }

      return parsed.data.map((display) => {
        return {
          id: display.id,
          index: display.index,
          name: display.name,
          x: display.x,
          y: display.y,
          width: display.width,
          height: display.height,
          scale: display.scale,
          isPrimary: display.isPrimary,
        }
      })
    },
    async clipboardGet(): Promise<string> {
      const result = unwrapData({
        result: nativeModule.clipboardGet(),
        fallbackCommand: 'clipboardGet',
      })
      if (result instanceof Error) {
        throw result
      }
      return result
    },
    async clipboardSet(input: { text: string }): Promise<void> {
      const result = nativeModule.clipboardSet(input)
      const maybeError = unwrapCommand({ result, fallbackCommand: 'clipboardSet' })
      if (maybeError instanceof Error) {
        throw maybeError
      }
    },
  }
}

export function createBridge(): UseComputerBridge {
  return createBridgeFromNative({ nativeModule: native })
}
