// Conservative read-only command sets. Unknown names never skip.

import type { AnalyzedCommand } from './bash.ts'

const READ_ONLY_COMMANDS = new Set([
  'ls',
  'dir',
  'cat',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ripgrep',
  'wc',
  'stat',
  'file',
  'pwd',
  'whoami',
  'id',
  'echo',
  'printf',
  'true',
  'false',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'which',
  'where',
  'type',
  'uname',
  'date',
  'sort',
  'uniq',
  'cut',
  'tr',
  'awk',
  'sed',
  'less',
  'more',
  'tree',
  'diff',
  'git',
  'find',
])

const READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'ls-files',
  'rev-parse',
  'describe',
  'cat-file',
  'grep',
  'branch',
  'remote',
  'version',
  'help',
])

function gitSubcommand(args: string[]) {
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    return arg.toLowerCase()
  }
  return undefined
}

export function isReadOnlyCommand(command: AnalyzedCommand) {
  if (command.unresolved || command.dynamicName || !command.name) return false
  if (!READ_ONLY_COMMANDS.has(command.name)) return false
  if (command.name === 'git') {
    const subcommand = gitSubcommand(command.args)
    if (!subcommand) return true
    return READ_ONLY_GIT.has(subcommand)
  }
  if (command.name === 'find') {
    return !command.args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir')
  }
  if (command.name === 'sed') {
    return !command.args.some((arg) => arg === '-i' || arg.startsWith('-i'))
  }
  return true
}
