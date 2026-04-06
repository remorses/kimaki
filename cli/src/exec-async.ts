import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const DEFAULT_EXEC_TIMEOUT_MS = 10_000

const _execAsync = promisify(exec)

export function execAsync(
  command: string,
  options?: Parameters<typeof _execAsync>[1],
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs =
    (options as { timeout?: number })?.timeout || DEFAULT_EXEC_TIMEOUT_MS
  const execPromise = _execAsync(command, options) as Promise<{
    stdout: string
    stderr: string
  }> & { child?: import('node:child_process').ChildProcess }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const pid = execPromise.child?.pid
      if (pid) {
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          execPromise.child?.kill('SIGTERM')
        }
      }
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)
  })
  return Promise.race([execPromise, timeoutPromise]).finally(() => {
    clearTimeout(timer)
  })
}
