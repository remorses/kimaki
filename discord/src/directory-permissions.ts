// Directory permission helpers for one-shot external directory preapproval.

import os from 'node:os'
import path from 'node:path'

export function normalizeAllowedDirectoryPath({
  input,
  workingDirectory,
}: {
  input: string
  workingDirectory: string
}): Error | string {
  const trimmedInput = input.trim()
  if (!trimmedInput) {
    return new Error('Path cannot be empty')
  }

  const withoutTrailingGlob = trimmedInput.replace(/[\\/]\*+$/u, '')
  if (!withoutTrailingGlob) {
    return new Error('Path cannot be empty')
  }
  if (withoutTrailingGlob.includes('*') || withoutTrailingGlob.includes('?')) {
    return new Error('Path must be a directory, not a glob pattern')
  }

  const expandedHomeDirectory = (() => {
    if (withoutTrailingGlob === '~') {
      return os.homedir()
    }
    if (withoutTrailingGlob.startsWith('~/')) {
      return path.join(os.homedir(), withoutTrailingGlob.slice(2))
    }
    return withoutTrailingGlob
  })()

  const absolutePath = path.isAbsolute(expandedHomeDirectory)
    ? expandedHomeDirectory
    : path.resolve(workingDirectory, expandedHomeDirectory)
  const normalizedPath = path.normalize(absolutePath)
  const root = path.parse(normalizedPath).root
  const withoutTrailingSlash = normalizedPath.length > root.length
    ? normalizedPath.replace(/[\\/]+$/u, '')
    : normalizedPath

  return withoutTrailingSlash.replaceAll('\\', '/')
}

export function buildAllowedDirectoryPatterns({
  directory,
}: {
  directory: string
}): string[] {
  const childPattern = directory.endsWith('/') ? `${directory}*` : `${directory}/*`
  return [directory, childPattern]
}
