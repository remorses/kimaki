// Shared OpenCode command resolution helpers.
// Normalizes `which`/`where` output across platforms and builds safe spawn
// arguments for Windows npm `.cmd` shims without relying on `shell: true`.

const WINDOWS_CMD_SHIM_REGEX = /\.(cmd|bat)$/i

export function splitCommandLookupOutput(output: string): string[] {
  return output
    .split(/\r?\n/g)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.length > 0
    })
}

export function selectResolvedCommand({
  output,
  isWindows,
}: {
  output: string
  isWindows: boolean
}): string | null {
  const lines = splitCommandLookupOutput(output)
  if (lines.length === 0) {
    return null
  }
  if (!isWindows) {
    return lines[0] || null
  }
  const cmdShim = lines.find((line) => {
    return WINDOWS_CMD_SHIM_REGEX.test(line)
  })
  return cmdShim || lines[0] || null
}

function quoteWindowsCommandSegment(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value
  }
  return `"${value.replaceAll('"', '\\"')}"`
}

export function getSpawnCommandAndArgs({
  resolvedCommand,
  baseArgs,
  platform,
}: {
  resolvedCommand: string
  baseArgs: string[]
  platform?: NodeJS.Platform
}): {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
} {
  const effectivePlatform = platform || process.platform
  if (effectivePlatform !== 'win32') {
    return { command: resolvedCommand, args: baseArgs }
  }

  if (!WINDOWS_CMD_SHIM_REGEX.test(resolvedCommand)) {
    return { command: resolvedCommand, args: baseArgs }
  }

  return {
    command: 'cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      quoteWindowsCommandSegment(resolvedCommand),
      ...baseArgs.map((arg) => {
        return quoteWindowsCommandSegment(arg)
      }),
    ],
    // Let cmd.exe receive the command line exactly as constructed above.
    // Without this, Node re-quotes the executable segment and npm shim paths
    // like `C:\Program Files\nodejs\opencode.cmd` break again.
    windowsVerbatimArguments: true,
  }
}
