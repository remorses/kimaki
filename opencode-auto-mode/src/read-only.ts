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
  'cut',
  'tr',
  'awk',
  'sed',
  'sort',
  'uniq',
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
  'version',
  'help',
])

const GIT_WRITE_FLAGS = new Set(['-D', '-d', '-m', '-M', '--delete', '--move', '--output'])
const GIT_HELPER_FLAGS = [
  '--ext-diff',
  '--filters',
  '--textconv',
  '--open-files-in-pager',
  '-O',
]

function gitSubcommand(args: string[]) {
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    return arg.toLowerCase()
  }
  return undefined
}

export function isReadOnlyCommand(command: AnalyzedCommand) {
  if (command.unresolved || command.dynamicName || !command.name) return false
  if (command.pathQualified || command.envMutatesPath) return false
  if (!READ_ONLY_COMMANDS.has(command.name)) return false
  if (command.name === 'git') {
    if (
      command.args.some(
        (arg) =>
          GIT_WRITE_FLAGS.has(arg) ||
          arg.startsWith('--output') ||
          GIT_HELPER_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
      )
    ) {
      return false
    }
    const subcommand = gitSubcommand(command.args)
    if (!subcommand) return true
    return READ_ONLY_GIT.has(subcommand)
  }
  if (command.name === 'rg' || command.name === 'ripgrep') {
    return !command.args.some(
      (arg) =>
        arg === '--pre' ||
        arg.startsWith('--pre=') ||
        arg === '-z' ||
        arg === '--search-zip',
    )
  }
  if (command.name === 'find') {
    return !command.args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir' || arg === '-fprintf')
  }
  if (command.name === 'sed') {
    return !command.args.some((arg) => arg === '-i' || arg.startsWith('-i') || arg === '--in-place' || arg.startsWith('--in-place='))
  }
  if (command.name === 'awk') {
    return !command.args.some((arg) => arg.includes('system('))
  }
  if (command.name === 'sort' || command.name === 'uniq') {
    return !command.args.some((arg) => arg === '-o' || arg.startsWith('--output'))
  }
  if (command.name === 'printf') {
    return !command.args.includes('-v')
  }
  return true
}
