// lintcn list — list installed rules with metadata from .lintcn/

import fs from 'node:fs'
import { getLintcnDir } from '../paths.ts'
import { discoverRules } from '../discover.ts'

export function listRules(): void {
  const lintcnDir = getLintcnDir()

  if (!fs.existsSync(lintcnDir)) {
    console.log('No .lintcn/ directory found. Run `lintcn add <url>` to add rules.')
    return
  }

  const rules = discoverRules(lintcnDir)

  if (rules.length === 0) {
    console.log('No rules installed. Run `lintcn add <url>` to add rules.')
    return
  }

  console.log('Installed rules:\n')

  const maxNameLen = Math.max(...rules.map((r) => { return r.name.length }))

  for (const rule of rules) {
    const name = rule.name.padEnd(maxNameLen + 2)
    const desc = rule.description || '(no description)'
    console.log(`  ${name}${desc}`)
  }

  console.log(`\n${rules.length} rule${rules.length === 1 ? '' : 's'} installed`)
}
