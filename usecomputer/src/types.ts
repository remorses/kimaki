// Shared types for usecomputer command parsing and backend bridge calls.

export type MouseButton = 'left' | 'right' | 'middle'

export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

export type Point = {
  x: number
  y: number
}

export type Region = {
  x: number
  y: number
  width: number
  height: number
}

export type DisplayInfo = {
  id: number
  name: string
  x: number
  y: number
  width: number
  height: number
  scale: number
  isPrimary: boolean
}

export type ScreenshotInput = {
  path?: string
  display?: number
  region?: Region
  annotate?: boolean
}

export type ScreenshotResult = {
  path: string
}

export type ClickInput = {
  point: Point
  button: MouseButton
  count: number
  modifiers: string[]
}

export type TypeInput = {
  text: string
  delayMs?: number
}

export type PressInput = {
  key: string
  count: number
  delayMs?: number
}

export type ScrollInput = {
  direction: ScrollDirection
  amount: number
  at?: Point
}

export type DragInput = {
  from: Point
  to: Point
  durationMs?: number
  button: MouseButton
}

export type NativeErrorObject = {
  code: string
  message: string
  command: string
}

export type NativeCommandResult = {
  ok: boolean
  error?: NativeErrorObject
}

export type NativeDataResult<T> = {
  ok: boolean
  data?: T
  error?: NativeErrorObject
}

export interface UseComputerBridge {
  screenshot(input: ScreenshotInput): Promise<ScreenshotResult>
  click(input: ClickInput): Promise<void>
  typeText(input: TypeInput): Promise<void>
  press(input: PressInput): Promise<void>
  scroll(input: ScrollInput): Promise<void>
  drag(input: DragInput): Promise<void>
  hover(input: Point): Promise<void>
  mouseMove(input: Point): Promise<void>
  mouseDown(input: { button: MouseButton }): Promise<void>
  mouseUp(input: { button: MouseButton }): Promise<void>
  mousePosition(): Promise<Point>
  displayList(): Promise<DisplayInfo[]>
  clipboardGet(): Promise<string>
  clipboardSet(input: { text: string }): Promise<void>
}
