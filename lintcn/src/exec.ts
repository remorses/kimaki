// Async process execution utility using spawn.
// Returns stdout/stderr as strings, rejects on non-zero exit code.

import { spawn } from 'node:child_process'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export function execAsync(
  command: string,
  args: string[],
  options?: { cwd?: string; stdio?: 'pipe' | 'inherit' },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      stdio: options?.stdio === 'inherit' ? 'inherit' : 'pipe',
    })

    let stdout = ''
    let stderr = ''

    if (proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
    }
    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
    }

    proc.on('error', (err) => {
      reject(new Error(`Failed to execute ${command}: ${err.message}`, { cause: err }))
    })

    proc.on('close', (code) => {
      const exitCode = code ?? 1
      if (exitCode !== 0 && options?.stdio !== 'inherit') {
        reject(new Error(`${command} exited with code ${exitCode}\n${stderr}`))
        return
      }
      resolve({ stdout, stderr, exitCode })
    })
  })
}
