// Shared OpenCode and Kimaki command resolution helpers.
// Normalizes `which`/`where` output across platforms, builds safe spawn
// arguments for Windows npm `.cmd` shims without relying on `shell: true`,
// and creates a stable `kimaki` shim for OpenCode child processes.

import fs from 'node:fs'
import path from 'node:path'

const WINDOWS_CMD_SHIM_REGEX = /\.(cmd|bat)$/i
const WINDOWS_EXECUTABLE_REGEX = /\.exe$/i
const BUN_SHIM_METADATA_VERSION = 5478
const BUN_SHIM_METADATA_MAX_BYTES = 65_536
const BUN_SHIM_EXECUTABLE_MAX_BYTES = 1_048_576
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002
const IMAGE_FILE_DLL = 0x2000

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

/**
 * Bun installs Windows package binaries as a small .exe launcher plus a
 * sibling .bunx metadata file. For native targets the launcher only starts
 * the encoded executable and waits, so spawning that target directly keeps
 * the ChildProcess PID attached to the process Kimaki must later terminate.
 */
export function resolveWindowsBunShimTarget({
  command,
  platform = process.platform,
}: {
  command: string
  platform?: NodeJS.Platform
}): string {
  if (platform !== 'win32' || !WINDOWS_EXECUTABLE_REGEX.test(command)) {
    return command
  }

  const commandDirectory = path.win32.dirname(command)
  const commandName = path.win32.basename(command, path.win32.extname(command))
  const metadataPath = path.win32.join(commandDirectory, `${commandName}.bunx`)

  try {
    const commandStat = fs.statSync(command)
    if (
      !commandStat.isFile() ||
      commandStat.size > BUN_SHIM_EXECUTABLE_MAX_BYTES ||
      !isWindowsPeExecutable(command)
    ) {
      return command
    }

    const metadataFd = fs.openSync(metadataPath, 'r')
    let metadata: Buffer
    try {
      const metadataStat = fs.fstatSync(metadataFd)
      if (
        !metadataStat.isFile() ||
        metadataStat.size < 8 ||
        metadataStat.size > BUN_SHIM_METADATA_MAX_BYTES
      ) {
        return command
      }
      metadata = Buffer.alloc(metadataStat.size)
      if (
        fs.readSync(metadataFd, metadata, 0, metadata.length, 0) !==
        metadata.length
      ) {
        return command
      }
    } finally {
      fs.closeSync(metadataFd)
    }

    const target = decodeWindowsBunShimTarget({
      command,
      metadata,
    })
    if (!target) {
      return command
    }

    const canonicalRoot = fs.realpathSync.native(
      path.win32.dirname(commandDirectory),
    )
    const canonicalTarget = fs.realpathSync.native(target)
    const canonicalRelativeTarget = path.win32.relative(
      canonicalRoot,
      canonicalTarget,
    )
    if (
      !canonicalRelativeTarget ||
      canonicalRelativeTarget === '..' ||
      canonicalRelativeTarget.startsWith(`..${path.win32.sep}`) ||
      path.win32.isAbsolute(canonicalRelativeTarget) ||
      !fs.statSync(canonicalTarget).isFile() ||
      !isWindowsPeExecutable(canonicalTarget)
    ) {
      return command
    }

    return canonicalTarget
  } catch {
    return command
  }
}

export function decodeWindowsBunShimTarget({
  command,
  metadata,
}: {
  command: string
  metadata: Buffer
}): string | null {
  const commandDirectory = path.win32.dirname(command)
  const commandDirectoryName = path.win32
    .basename(commandDirectory)
    .toLowerCase()
  if (
    (commandDirectoryName !== 'bin' && commandDirectoryName !== '.bin') ||
    metadata.length < 8 ||
    metadata.length > BUN_SHIM_METADATA_MAX_BYTES ||
    metadata.length % 2 !== 0
  ) {
    return null
  }

  const flags = metadata.readUInt16LE(metadata.length - 2)
  if (flags >>> 3 !== BUN_SHIM_METADATA_VERSION || (flags & 0b111) !== 0) {
    return null
  }

  const targetByteLength = metadata.length - 6
  if (
    targetByteLength < 2 ||
    metadata.readUInt16LE(targetByteLength) !== 0x22 ||
    metadata.readUInt16LE(targetByteLength + 2) !== 0
  ) {
    return null
  }

  const relativeTarget = metadata
    .subarray(0, targetByteLength)
    .toString('utf16le')
  if (!relativeTarget || relativeTarget.includes('\0')) {
    return null
  }

  // Bun resolves metadata from the parent of its bin/.bin directory.
  const targetRoot = path.win32.dirname(path.win32.dirname(command))
  const target = path.win32.resolve(targetRoot, relativeTarget)
  const relativeResolvedTarget = path.win32.relative(targetRoot, target)
  if (
    !relativeResolvedTarget ||
    relativeResolvedTarget === '..' ||
    relativeResolvedTarget.startsWith(`..${path.win32.sep}`) ||
    path.win32.isAbsolute(relativeResolvedTarget) ||
    !WINDOWS_EXECUTABLE_REGEX.test(target)
  ) {
    return null
  }

  return target
}

function isWindowsPeExecutable(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size < 0x5a) {
      return false
    }

    const dosHeader = Buffer.alloc(0x40)
    if (
      fs.readSync(fd, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length ||
      dosHeader[0] !== 0x4d ||
      dosHeader[1] !== 0x5a
    ) {
      return false
    }

    const peOffset = dosHeader.readUInt32LE(0x3c)
    const peHeader = Buffer.alloc(26)
    if (
      peOffset < dosHeader.length ||
      peOffset > stat.size - peHeader.length ||
      fs.readSync(fd, peHeader, 0, peHeader.length, peOffset) !==
        peHeader.length ||
      peHeader.toString('ascii', 0, 4) !== 'PE\0\0'
    ) {
      return false
    }

    const optionalHeaderSize = peHeader.readUInt16LE(20)
    const characteristics = peHeader.readUInt16LE(22)
    const optionalHeaderMagic = peHeader.readUInt16LE(24)
    const numberOfSections = peHeader.readUInt16LE(6)
    const minimumOptionalHeaderSize =
      optionalHeaderMagic === 0x10b
        ? 0x60
        : optionalHeaderMagic === 0x20b
          ? 0x70
          : Number.POSITIVE_INFINITY
    const sectionTableEnd =
      peOffset + 24 + optionalHeaderSize + numberOfSections * 40
    return (
      numberOfSections > 0 &&
      optionalHeaderSize >= minimumOptionalHeaderSize &&
      sectionTableEnd <= stat.size &&
      (characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) !== 0 &&
      (characteristics & IMAGE_FILE_DLL) === 0
    )
  } finally {
    fs.closeSync(fd)
  }
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

// Remove flags from the parent process's execArgv that must not leak into the
// relocatable kimaki shim. The shim runs from arbitrary working directories
// (it is on PATH for opencode child processes), so a relative `--env-file=.env`
// would make node abort with ".env: not found" whenever the cwd has no .env.
// The shim does not need to re-load env files at all: the env vars the bot
// cares about are already in the inherited process environment. We strip both
// `--env-file`/`--env-file-if-exists` forms: `--env-file=value` (single arg)
// and `--env-file value` (two args).
export function sanitizeShimExecArgv(execArgv: string[]): string[] {
  const sanitized: string[] = []
  for (let index = 0; index < execArgv.length; index++) {
    const arg = execArgv[index]!
    if (arg === '--env-file' || arg === '--env-file-if-exists') {
      // Skip this flag and its separate value argument, if present.
      index++
      continue
    }
    if (arg.startsWith('--env-file=') || arg.startsWith('--env-file-if-exists=')) {
      continue
    }
    sanitized.push(arg)
  }
  return sanitized
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
    const launcherArgs = [...sanitizeShimExecArgv(execArgv), entryScript]

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
