#!/usr/bin/env tsx
/**
 * Copy the canonical repository skills/ folder into cli/skills/.
 * This keeps the npm package self-contained for build and publish while the
 * tracked source of truth stays at the repository root.
 */

import fs from 'node:fs'
import path from 'node:path'

function main() {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname)
  const cliDir = path.resolve(scriptDir, '..')
  const repoRootDir = path.resolve(cliDir, '..')
  const sourceDir = path.join(repoRootDir, 'skills')
  const targetDir = path.join(cliDir, 'skills')

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Canonical skills directory not found: ${sourceDir}`)
  }

  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
  })

  const copiedSkillCount = fs
    .readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => {
      return entry.isDirectory()
    })
    .length

  console.log(`Copied ${copiedSkillCount} skill(s) to ${targetDir}`)
}

main()
