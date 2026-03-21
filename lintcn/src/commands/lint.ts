// lintcn lint — build a custom tsgolint binary and run it against the project.
// Handles Go workspace generation, compilation with caching, and execution.

import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { getLintcnDir } from '../paths.ts'
import { discoverRules } from '../discover.ts'
import { generateBuildWorkspace } from '../codegen.ts'
import { ensureTsgolintSource, DEFAULT_TSGOLINT_VERSION, cachedBinaryExists, getBinaryPath, getBuildDir, getBinDir } from '../cache.ts'
import { computeContentHash } from '../hash.ts'
import { execAsync } from '../exec.ts'

async function checkGoInstalled(): Promise<void> {
  try {
    await execAsync('go', ['version'])
  } catch {
    throw new Error(
      'Go 1.26+ is required to build rules.\n' +
      'Install from https://go.dev/dl/',
    )
  }
}

export async function buildBinary({
  rebuild,
  tsgolintVersion,
}: {
  rebuild: boolean
  tsgolintVersion: string
}): Promise<string> {
  await checkGoInstalled()

  const lintcnDir = getLintcnDir()
  if (!fs.existsSync(lintcnDir)) {
    throw new Error('No .lintcn/ directory found. Run `lintcn add <url>` first.')
  }

  const rules = discoverRules(lintcnDir)
  if (rules.length === 0) {
    throw new Error('No rules found in .lintcn/. Run `lintcn add <url>` to add rules.')
  }

  console.log(`Found ${rules.length} custom rule${rules.length === 1 ? '' : 's'} (tsgolint ${tsgolintVersion})`)

  // ensure tsgolint source
  const tsgolintDir = await ensureTsgolintSource(tsgolintVersion)

  // compute content hash
  const contentHash = await computeContentHash({
    lintcnDir,
    tsgolintVersion,
  })

  // check cache
  if (!rebuild && cachedBinaryExists(contentHash)) {
    console.log('Using cached binary')
    return getBinaryPath(contentHash)
  }

  // generate build workspace
  const buildDir = getBuildDir()
  console.log('Generating build workspace...')
  generateBuildWorkspace({
    buildDir,
    tsgolintDir,
    lintcnDir,
    rules,
  })

  // compile
  const binDir = getBinDir()
  fs.mkdirSync(binDir, { recursive: true })
  const binaryPath = getBinaryPath(contentHash)

  console.log('Compiling custom tsgolint binary...')
  await execAsync('go', ['build', '-o', binaryPath, './wrapper'], {
    cwd: buildDir,
  })

  console.log('Build complete')
  return binaryPath
}

export async function lint({
  rebuild,
  tsgolintVersion,
  passthroughArgs,
}: {
  rebuild: boolean
  tsgolintVersion: string
  passthroughArgs: string[]
}): Promise<number> {
  const binaryPath = await buildBinary({ rebuild, tsgolintVersion })

  // run the binary with passthrough args, inheriting stdio
  return new Promise((resolve) => {
    const proc = spawn(binaryPath, passthroughArgs, {
      stdio: 'inherit',
    })

    proc.on('error', (err) => {
      console.error(`Failed to run binary: ${err.message}`)
      resolve(1)
    })

    proc.on('close', (code) => {
      resolve(code ?? 1)
    })
  })
}
