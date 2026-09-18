import type { Plugin } from '@opencode-ai/plugin'

// Work around https://github.com/anomalyco/opencode/issues/49599 until invalid task IDs are ignored upstream.
export function sanitizeTaskArguments(args: Record<string, unknown>) {
  const taskId = args.task_id
  if (typeof taskId !== 'string' || taskId.startsWith('ses')) return
  delete args.task_id
}

export const taskIdPlugin: Plugin = async () => {
  return {
    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'task') return
      sanitizeTaskArguments(output.args)
    },
  }
}
