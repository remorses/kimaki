// Shared OpenCode and Kimaki command resolution helpers.
// Normalizes `which`/`where` output across platforms, builds safe spawn
// arguments for Windows npm `.cmd` shims without relying on `shell: true`,
// and creates a stable `kimaki` shim for OpenCode child processes.

import fs from 'node:fs'
import path from 'node:path'

const WINDOWS_CMD_SHIM_REGEX = /\.(cmd|bat)$/i

function quotePosixShellSegment(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

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

export function ensureKimakiCommandShim({
  dataDir,
  execPath,
  execArgv,
  entryScript,
  platform,
}: {
  dataDir: string
  execPath: string
  execArgv: string[]
  entryScript: string
  platform?: NodeJS.Platform
}): string | Error {
  const effectivePlatform = platform || process.platform
  const shimDirectory = path.join(dataDir, 'bin')

  try {
    fs.mkdirSync(shimDirectory, { recursive: true })
    const launcherArgs = [...execArgv, entryScript]

    if (effectivePlatform === 'win32') {
      const shimPath = path.join(shimDirectory, 'kimaki.cmd')
      const shimContent = [
        '@echo off',
        [execPath, ...launcherArgs].map((segment) => {
          return `"${segment.replaceAll('"', '""')}"`
        }).join(' ') + ' %*',
        '',
      ].join('\r\n')
      writeShimIfNeeded({
        shimPath,
        shimContent,
      })
      return shimDirectory
    }

    const shimPath = path.join(shimDirectory, 'kimaki')
    const shimContent = [
      '#!/bin/sh',
      `exec ${[execPath, ...launcherArgs].map((segment) => {
        return quotePosixShellSegment(segment)
      }).join(' ')} "$@"`,
      '',
    ].join('\n')
    writeShimIfNeeded({
      shimPath,
      shimContent,
      mode: 0o755,
    })
    return shimDirectory
  } catch (cause) {
    return new Error('Failed to create kimaki command shim', { cause })
  }
}

export function prependPathEntry({
  entry,
  existingPath,
}: {
  entry: string
  existingPath?: string
}): string {
  const pathEntries = (existingPath || '').split(path.delimiter).filter((segment) => {
    return segment.length > 0
  })
  if (pathEntries.includes(entry)) {
    return existingPath || entry
  }
  return [entry, ...pathEntries].join(path.delimiter)
}

export function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => {
    return key.toLowerCase() === 'path'
  }) || 'PATH'
}

function writeShimIfNeeded({
  shimPath,
  shimContent,
  mode,
}: {
  shimPath: string
  shimContent: string
  mode?: number
}): void {
  const existingContent = fs.existsSync(shimPath)
    ? fs.readFileSync(shimPath, 'utf8')
    : null
  if (existingContent !== shimContent) {
    fs.writeFileSync(shimPath, shimContent, 'utf8')
  }
  if (mode !== undefined) {
    fs.chmodSync(shimPath, mode)
  }
}
