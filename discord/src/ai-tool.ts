// Minimal tool definition helper used by Kimaki.
// This replaces the Vercel AI SDK `tool()` helper so Kimaki can define typed
// tools (Zod input schema + execute) without depending on the full `ai` package.

import type { z } from 'zod'

export type ToolExecuteOptions = {
  toolCallId?: string
  abortSignal?: AbortSignal
  messages?: unknown[]
}

type BivariantCallback<Args extends unknown[], Return> = {
  bivarianceHack(...args: Args): Return
}['bivarianceHack']

export type Tool<Input, Output> = {
  description?: string
  inputSchema: z.ZodType<Input>
  execute?: BivariantCallback<
    [input: Input, options: ToolExecuteOptions],
    Promise<Output> | Output
  >
}

export type AnyTool = {
  description?: string
  inputSchema: z.ZodTypeAny
  execute?: BivariantCallback<
    [input: unknown, options: ToolExecuteOptions],
    Promise<unknown> | unknown
  >
}

export function tool<Input, Output>(definition: Tool<Input, Output>): Tool<Input, Output> {
  return definition
}
