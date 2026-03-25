#!/usr/bin/env node
// profano — CLI tool to analyze .cpuprofile files and print top functions
// by self-time or total-time in the terminal. Designed for AI agents and
// humans who want quick profiling insights without opening a browser.

import { goke } from 'goke'
import { z } from 'zod'
import { globSync } from 'node:fs'
import { loadProfile, analyze } from './parse.js'
import { formatTable, type SortMode } from './format.js'

const cli = goke('profano')

cli
  .command('<files...>', 'Analyze .cpuprofile files and print top functions')
  .option(
    '-n, --limit [limit]',
    z.number().default(30).describe('Number of top functions to show'),
  )
  .option(
    '-s, --sort [sort]',
    z.enum(['self', 'total']).default('self').describe('Sort by self-time or total/inclusive time'),
  )
  .example('# Analyze a single profile (sorted by self-time)')
  .example('profano ./tmp/cpu-profiles/CPU.*.cpuprofile')
  .example('# Sort by total/inclusive time')
  .example('profano profile.cpuprofile --sort total')
  .example('# Show top 50 functions')
  .example('profano profile.cpuprofile -n 50')
  .action((files, options) => {
    // goke variadic args can be string[] or string depending on input
    const fileList: string[] = Array.isArray(files) ? files : [files]

    // Expand globs if shell didn't
    const resolved: string[] = fileList.flatMap((f: string) => {
      if (f.includes('*')) {
        const matches = globSync(f)
        return matches.length > 0 ? matches : [f]
      }
      return [f]
    })

    if (resolved.length === 0) {
      console.error('No .cpuprofile files found')
      process.exit(1)
    }

    const sort = options.sort as SortMode

    for (const filePath of resolved) {
      if (resolved.length > 1) {
        console.log(`\n━━━ ${filePath} ━━━\n`)
      }

      const profile = loadProfile(filePath)
      const result = analyze(profile)
      console.log(formatTable({ ...result, limit: options.limit, sort }))
    }
  })

cli.help()
cli.version('0.0.1')
cli.parse()
