#!/usr/bin/env node

// lintcn — the shadcn for type-aware TypeScript lint rules.
// Add rules by URL, compile, and run them via tsgolint.

import { goke } from 'goke'
import { createRequire } from 'node:module'
import { addRule } from './commands/add.ts'
import { lint, buildBinary } from './commands/lint.ts'
import { listRules } from './commands/list.ts'
import { removeRule } from './commands/remove.ts'
import { DEFAULT_TSGOLINT_VERSION } from './cache.ts'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json') as { version: string }

const cli = goke('lintcn')

cli
  .command('add <url>', 'Add a rule by URL. Fetches the .go file and copies it into .lintcn/')
  .example('# Add a rule from GitHub')
  .example('lintcn add https://github.com/user/repo/blob/main/rules/no_floating_promises.go')
  .example('# Add from raw URL')
  .example('lintcn add https://raw.githubusercontent.com/user/repo/main/rules/no_unused_result.go')
  .action(async (url) => {
    await addRule(url)
  })

cli
  .command('remove <name>', 'Remove an installed rule from .lintcn/')
  .example('lintcn remove no-floating-promises')
  .action((name) => {
    removeRule(name)
  })

cli
  .command('list', 'List all installed rules')
  .action(() => {
    listRules()
  })

cli
  .command('lint', 'Build custom tsgolint binary and run it against the project')
  .option('--rebuild', 'Force rebuild even if cached binary exists')
  .option('--tsconfig <path>', 'Path to tsconfig.json')
  .option('--list-files', 'List matched files')
  .option('--tsgolint-version [version]', 'Override the pinned tsgolint version (tag or commit). For testing unreleased tsgolint versions.')
  .action(async (options) => {
    const tsgolintVersion = (options.tsgolintVersion as string) || DEFAULT_TSGOLINT_VERSION
    const passthroughArgs: string[] = []
    if (options.tsconfig) {
      passthroughArgs.push('--tsconfig', options.tsconfig as string)
    }
    if (options.listFiles) {
      passthroughArgs.push('--list-files')
    }
    // pass through anything after --
    const doubleDash = options['--']
    if (doubleDash && Array.isArray(doubleDash)) {
      passthroughArgs.push(...doubleDash)
    }
    const exitCode = await lint({
      rebuild: !!options.rebuild,
      tsgolintVersion,
      passthroughArgs,
    })
    process.exit(exitCode)
  })

cli
  .command('build', 'Build the custom tsgolint binary without running it')
  .option('--rebuild', 'Force rebuild even if cached binary exists')
  .option('--tsgolint-version [version]', 'Override the pinned tsgolint version (tag or commit). For testing unreleased tsgolint versions.')
  .action(async (options) => {
    const tsgolintVersion = (options.tsgolintVersion as string) || DEFAULT_TSGOLINT_VERSION
    const binaryPath = await buildBinary({ rebuild: !!options.rebuild, tsgolintVersion })
    console.log(binaryPath)
  })

cli.help()
cli.version(packageJson.version)
cli.parse()
