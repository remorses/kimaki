// Deterministic blocks that never consult the classifier.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AnalyzedCommand, AnalyzedPipeline, AnalyzedRedirect } from './bash.ts'

const HOME = os.homedir()

const PROFILE_BASENAMES = new Set([
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.zlogin',
])

const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])
const FETCHERS = new Set(['curl', 'wget'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const PASSTHROUGH = new Set(['cat', 'tee', 'head', 'tail'])

function isRecursiveRmArg(arg: string) {
  return (
    (arg.length > 2 && arg.startsWith('--') && '--recursive'.startsWith(arg)) ||
    /^-[A-Za-z]*r[A-Za-z]*f?[A-Za-z]*$/i.test(arg) ||
    /^-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*$/i.test(arg)
  )
}

function expandHome({
  value,
  text,
  tildeExpansion,
}: {
  value: string
  text?: string
  tildeExpansion?: boolean
}) {
  if (tildeExpansion && (text === '~' || text?.startsWith('~/'))) {
    return text === '~' ? HOME : path.join(HOME, text.slice(2))
  }
  if (value === '$HOME') return HOME
  if (value.startsWith('$HOME/')) return path.join(HOME, value.slice(6))
  if (tildeExpansion && (value === '~' || value.startsWith('~/'))) {
    return value === '~' ? HOME : path.join(HOME, value.slice(2))
  }
  return value
}

function normalizeRootish(value: string) {
  const resolved = path.resolve(value)
  if (resolved === path.parse(resolved).root) return '/'
  return resolved
}

function isRootOrHome({
  value,
  text,
  tildeExpansion,
}: {
  value: string
  text?: string
  tildeExpansion?: boolean
}) {
  const expanded = expandHome({ value, text, tildeExpansion })
  const normalized = normalizeRootish(expanded)
  return normalized === '/' || normalized === path.resolve(HOME)
}

function realpathOrResolve(filePath: string) {
  try {
    return fs.realpathSync.native(filePath)
  } catch {
    return path.resolve(filePath)
  }
}

function canonicalPath(filePath: string, cwd: string) {
  const resolved = path.resolve(cwd, filePath)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    let current = path.dirname(resolved)
    while (true) {
      try {
        return path.join(fs.realpathSync.native(current), path.relative(current, resolved))
      } catch {
        const parent = path.dirname(current)
        if (parent === current) return resolved
        current = parent
      }
    }
  }
}

function looksLikeProfileWrite(value: string, cwd: string) {
  const canonical = canonicalPath(value, cwd)
  for (const basename of PROFILE_BASENAMES) {
    if (canonical === path.join(HOME, basename)) return true
  }
  return false
}

function looksLikeAuthorizedKeys(value: string, cwd: string) {
  return canonicalPath(value, cwd) === path.join(HOME, '.ssh', 'authorized_keys')
}

function looksLikeGuardConfig(filePath: string, cwd: string) {
  return canonicalPath(filePath, cwd) === path.join(realpathOrResolve(cwd), '.opencode', 'auto-mode.json')
}

export function hardDenyReason(command: AnalyzedCommand) {
  if (!command.name) return undefined
  const args = command.args

  if (command.name === 'rm') {
    const recursive = args.some(isRecursiveRmArg)
    if (recursive) {
      for (const [index, value] of args.entries()) {
        if (value.startsWith('-') && value !== '-') continue
        if (
          isRootOrHome({
            value,
            text: command.argTexts[index],
            tildeExpansion: command.argTildeExpansions[index],
          })
        ) {
          return 'Recursive delete of root or home'
        }
      }
    }
  }

  if (command.name === 'chmod' && args.includes('777')) {
    return 'chmod 777'
  }

  if (command.name === 'dd' || command.name === 'mkfs' || command.name.startsWith('mkfs.')) {
    return `Disk-destructive command ${command.name}`
  }

  if (['shutdown', 'reboot', 'halt', 'poweroff'].includes(command.name)) {
    return `System ${command.name}`
  }

  return undefined
}

export function hardDenyWritePath(filePath: string, cwd = process.cwd()) {
  const expanded = expandHome({ value: filePath, text: filePath, tildeExpansion: filePath.startsWith('~') })
  if (looksLikeProfileWrite(expanded, cwd)) return `Write to shell profile ${filePath}`
  if (looksLikeAuthorizedKeys(expanded, cwd)) return `Write to ${filePath}`
  if (looksLikeGuardConfig(expanded, cwd)) return `Write to auto-mode config ${filePath}`
  return undefined
}

export function hardDenyRedirect(redirect: AnalyzedRedirect, cwd: string) {
  if (!OUTPUT_REDIRECTS.has(redirect.operator)) return undefined
  if (!redirect.target || redirect.targetDynamic) return undefined
  const expanded = expandHome({
    value: redirect.target,
    text: redirect.targetText,
    tildeExpansion: redirect.tildeExpansion,
  })
  return hardDenyWritePath(expanded, cwd)
}

export function pipelineHardDeny(pipelines: AnalyzedPipeline[]) {
  for (const pipeline of pipelines) {
    const names = pipeline.commands.map((command) => command.name)
    const hasFetcher = names.some((name) => name && FETCHERS.has(name))
    const hasShell = names.some((name) => name && SHELLS.has(name))
    if (hasFetcher && hasShell) {
      const onlyPassthrough = names.every(
        (name) => !name || FETCHERS.has(name) || SHELLS.has(name) || PASSTHROUGH.has(name),
      )
      if (onlyPassthrough) return 'Remote script piped to a shell'
    }
  }
  return undefined
}

export { looksLikeProfileWrite, looksLikeAuthorizedKeys }
