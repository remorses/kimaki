// lintcn remove <name> — delete a rule and its test file from .lintcn/

import fs from 'node:fs'
import path from 'node:path'
import { getLintcnDir } from '../paths.ts'
import { discoverRules } from '../discover.ts'

export function removeRule(name: string): void {
  const lintcnDir = getLintcnDir()

  if (!fs.existsSync(lintcnDir)) {
    throw new Error('No .lintcn/ directory found.')
  }

  // match by lintcn:name metadata or by filename
  const rules = discoverRules(lintcnDir)
  const normalizedName = name.replace(/-/g, '_')

  const match = rules.find((r) => {
    return r.name === name || r.fileName.replace(/\.go$/, '') === normalizedName
  })

  if (!match) {
    throw new Error(
      `Rule "${name}" not found. Run \`lintcn list\` to see installed rules.`,
    )
  }

  // delete rule file
  const rulePath = path.join(lintcnDir, match.fileName)
  fs.rmSync(rulePath)
  console.log(`Removed ${match.fileName}`)

  // delete test file if exists
  const testFileName = match.fileName.replace(/\.go$/, '_test.go')
  const testPath = path.join(lintcnDir, testFileName)
  if (fs.existsSync(testPath)) {
    fs.rmSync(testPath)
    console.log(`Removed ${testFileName}`)
  }
}
