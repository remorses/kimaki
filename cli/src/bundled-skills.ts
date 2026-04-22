// Bundled Kimaki skills path helpers.
// The canonical tracked skills live at the repository root in /skills.
// Build and publish scripts copy them into cli/skills so the npm package ships
// the same files. Prefer the repo-root directory during local development and
// fall back to the packaged cli/skills directory when running from npm.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function getCliDir(): string {
  const currentFilePath = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFilePath), '..')
}

export function resolvePackagedBundledSkillsDir(): string {
  return path.join(getCliDir(), 'skills')
}

export function resolveBundledSkillsDir(): string {
  const repoSkillsDir = path.resolve(getCliDir(), '..', 'skills')
  if (fs.existsSync(repoSkillsDir)) {
    return repoSkillsDir
  }

  return resolvePackagedBundledSkillsDir()
}

export function listBundledSkillNames(): string[] {
  try {
    return fs
      .readdirSync(resolveBundledSkillsDir(), { withFileTypes: true })
      .filter((entry) => {
        return entry.isDirectory()
      })
      .map((entry) => {
        return entry.name
      })
  } catch {
    return []
  }
}
