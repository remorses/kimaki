// Deterministic blocks that never consult the classifier.

import os from 'node:os'
import path from 'node:path'
import type { AnalyzedCommand } from './bash.ts'

const HOME = os.homedir()

const PROFILE_BASENAMES = new Set([
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.zlogin',
])

function isRecursiveRmArg(arg: string) {
  return (
    (arg.length > 2 && arg.startsWith('--') && '--recursive'.startsWith(arg)) ||
    /^-[A-Za-z]*r[A-Za-z]*f?[A-Za-z]*$/i.test(arg) ||
    /^-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*$/i.test(arg)
  )
}

function expandHome(value: string) {
  if (value === '~' || value === '$HOME') return HOME
  if (value.startsWith('~/')) return path.join(HOME, value.slice(2))
  if (value.startsWith('$HOME/')) return path.join(HOME, value.slice(6))
  return value
}

function isRootOrHome(value: string) {
  const expanded = expandHome(value)
  return expanded === '/' || expanded === HOME || expanded === '~'
}

function looksLikeProfileWrite(value: string) {
  const expanded = expandHome(value)
  return PROFILE_BASENAMES.has(path.basename(expanded))
}

function looksLikeAuthorizedKeys(value: string) {
  const expanded = expandHome(value)
  return expanded.endsWith(`${path.sep}.ssh${path.sep}authorized_keys`) ||
    expanded === path.join(HOME, '.ssh', 'authorized_keys')
}

export function hardDenyReason(command: AnalyzedCommand) {
  if (!command.name) return undefined
  const args = command.args

  if (command.name === 'rm') {
    const recursive = args.some(isRecursiveRmArg)
    if (recursive && args.some(isRootOrHome)) {
      return 'Recursive delete of root or home'
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

export function hardDenyWritePath(filePath: string) {
  if (looksLikeProfileWrite(filePath)) return `Write to shell profile ${filePath}`
  if (looksLikeAuthorizedKeys(filePath)) return `Write to ${filePath}`
  return undefined
}

export function pipelineHardDeny(commands: AnalyzedCommand[]) {
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!
    if (command.name === 'curl' || command.name === 'wget') {
      const next = commands[index + 1]
      if (next?.name === 'sh' || next?.name === 'bash') {
        return 'Remote script piped to a shell'
      }
    }
  }
  return undefined
}

export { looksLikeProfileWrite, looksLikeAuthorizedKeys }
