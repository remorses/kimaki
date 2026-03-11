// Native bridge that maps typed TS calls to the Zig N-API command dispatcher.

import { native, type NativeModule } from './native-lib.js'
import type {
  ClickInput,
  DragInput,
  Point,
  PressInput,
  ScreenshotInput,
  ScreenshotResult,
  ScrollInput,
  TypeInput,
  UseComputerBridge,
  DisplayInfo,
} from './types.js'

const unavailableError =
  'Native backend is unavailable. Build it with `pnpm build:native` or `zig build` in usecomputer/.'

function execute<T>({
  nativeModule,
  command,
  payload,
}: {
  nativeModule: NativeModule
  command: string
  payload: unknown
}): Error | T {
  const response = nativeModule.execute(command, JSON.stringify(payload))
  const parsed = JSON.parse(response) as { ok: boolean; data?: T; error?: string }
  if (!parsed.ok) {
    return new Error(parsed.error || `Native command failed: ${command}`)
  }
  return parsed.data as T
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
      const result = execute<ScreenshotResult>({ nativeModule, command: 'screenshot', payload: input })
      if (result instanceof Error) {
        throw result
      }
      return result
    },
    async click(input: ClickInput): Promise<void> {
      const result = execute<null>({ nativeModule, command: 'click', payload: input })
      if (result instanceof Error) {
        throw result
      }
    },
    async typeText(input: TypeInput): Promise<void> {
      const result = execute<null>({ nativeModule, command: 'type-text', payload: input })
      if (result instanceof Error) {
        throw result
      }
    },
    async press(input: PressInput): Promise<void> {
      const result = execute<null>({ nativeModule, command: 'press', payload: input })
      if (result instanceof Error) {
        throw result
      }
    },
    async scroll(input: ScrollInput): Promise<void> {
      const result = execute<null>({ nativeModule, command: 'scroll', payload: input })
      if (result instanceof Error) {
        throw result
      }
    },
    async drag(input: DragInput): Promise<void> {
      const result = execute<null>({ nativeModule, command: 'drag', payload: input })
      if (result instanceof Error) {
        throw result
      }
    },
    async hover(input: Point): Promise<void> {
      const result = execute<null>({ nativeModule, command: 'hover', payload: input })
      if (result instanceof Error) {
        throw result
      }
    },
    async mouseMove(input: Point): Promise<void> {
      const result = execute<null>({ nativeModule, command: 'mouse-move', payload: input })
      if (result instanceof Error) {
        throw result
      }
    },
    async mouseDown(input: { button: 'left' | 'right' | 'middle' }): Promise<void> {
      const result = execute<null>({ nativeModule, command: 'mouse-down', payload: input })
      if (result instanceof Error) {
        throw result
      }
    },
    async mouseUp(input: { button: 'left' | 'right' | 'middle' }): Promise<void> {
      const result = execute<null>({ nativeModule, command: 'mouse-up', payload: input })
      if (result instanceof Error) {
        throw result
      }
    },
    async mousePosition(): Promise<Point> {
      const result = execute<Point>({ nativeModule, command: 'mouse-position', payload: {} })
      if (result instanceof Error) {
        throw result
      }
      return result
    },
    async displayList(): Promise<DisplayInfo[]> {
      const result = execute<DisplayInfo[]>({ nativeModule, command: 'display-list', payload: {} })
      if (result instanceof Error) {
        throw result
      }
      return result
    },
    async clipboardGet(): Promise<string> {
      const result = execute<{ text: string }>({ nativeModule, command: 'clipboard-get', payload: {} })
      if (result instanceof Error) {
        throw result
      }
      return result.text
    },
    async clipboardSet(input: { text: string }): Promise<void> {
      const result = execute<null>({ nativeModule, command: 'clipboard-set', payload: input })
      if (result instanceof Error) {
        throw result
      }
    },
  }
}

export function createBridge(): UseComputerBridge {
  return createBridgeFromNative({ nativeModule: native })
}
