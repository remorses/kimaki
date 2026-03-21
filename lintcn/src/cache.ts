// Manage cached tsgolint source and compiled binaries.
// Downloads tsgolint + typescript-go as tarballs from GitHub (no git required),
// applies patches with `patch -p1`, and copies internal/collections.
//
// Cache layout:
//   ~/.cache/lintcn/tsgolint/<version>/   — extracted source (read-only)
//   ~/.cache/lintcn/bin/<content-hash>    — compiled binaries

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { execAsync } from './exec.ts'

// Pinned tsgolint version — updated with each lintcn release.
// This ensures reproducible builds: every user on the same lintcn version
// compiles rules against the same tsgolint API. Changing this is a conscious
// decision — tsgolint API changes can break user rules.
export const DEFAULT_TSGOLINT_VERSION = 'v0.9.2'

// Pinned typescript-go commit that tsgolint v0.9.2 depends on.
// Found via `git ls-tree HEAD typescript-go` in the tsgolint repo.
// Must be updated when DEFAULT_TSGOLINT_VERSION changes.
const TYPESCRIPT_GO_COMMIT = '2437fa43e85103d2a18e8e41e1a2a994d0708ccf'

export function getCacheDir(): string {
  return path.join(os.homedir(), '.cache', 'lintcn')
}

export function getTsgolintSourceDir(version: string): string {
  return path.join(getCacheDir(), 'tsgolint', version)
}

export function getBinDir(): string {
  return path.join(getCacheDir(), 'bin')
}

export function getBinaryPath(contentHash: string): string {
  return path.join(getBinDir(), contentHash)
}

export function getBuildDir(): string {
  return path.join(getCacheDir(), 'build')
}

/** Download a tarball from URL and extract it to targetDir.
 *  GitHub tarballs have a top-level directory like `repo-ref/`,
 *  so we strip the first path component during extraction. */
async function downloadAndExtract(url: string, targetDir: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }

  fs.mkdirSync(targetDir, { recursive: true })

  // pipe through gunzip, then extract with tar (strip top-level directory)
  const tmpTarGz = path.join(os.tmpdir(), `lintcn-${Date.now()}.tar.gz`)
  const fileStream = fs.createWriteStream(tmpTarGz)
  // @ts-ignore ReadableStream vs NodeJS.ReadableStream mismatch
  await pipeline(response.body, fileStream)

  await execAsync('tar', ['xzf', tmpTarGz, '--strip-components=1', '-C', targetDir])
  fs.rmSync(tmpTarGz, { force: true })
}

/** Apply git-format patches using `patch -p1` (no git required).
 *  Patches are standard unified diff format, `patch` ignores the git metadata. */
async function applyPatches(patchesDir: string, targetDir: string): Promise<number> {
  const patches = fs.readdirSync(patchesDir)
    .filter((f) => { return f.endsWith('.patch') })
    .sort()

  for (const patchFile of patches) {
    const patchPath = path.join(patchesDir, patchFile)
    // --batch silences interactive prompts, -f forces application
    await execAsync('patch', ['-p1', '--batch', '-i', patchPath], { cwd: targetDir })
  }

  return patches.length
}

export async function ensureTsgolintSource(version: string): Promise<string> {
  const sourceDir = getTsgolintSourceDir(version)
  const readyMarker = path.join(sourceDir, '.lintcn-ready')

  if (fs.existsSync(readyMarker)) {
    return sourceDir
  }

  // clean up any partial previous attempt so we start fresh
  if (fs.existsSync(sourceDir)) {
    fs.rmSync(sourceDir, { recursive: true })
  }

  try {
    // download tsgolint source tarball
    console.log(`Downloading tsgolint@${version}...`)
    const tsgolintUrl = `https://github.com/oxc-project/tsgolint/archive/refs/tags/${version}.tar.gz`
    await downloadAndExtract(tsgolintUrl, sourceDir)

    // download typescript-go source tarball into tsgolint/typescript-go/
    const tsGoDir = path.join(sourceDir, 'typescript-go')
    console.log('Downloading typescript-go...')
    const tsGoUrl = `https://github.com/microsoft/typescript-go/archive/${TYPESCRIPT_GO_COMMIT}.tar.gz`
    await downloadAndExtract(tsGoUrl, tsGoDir)

    // apply patches to typescript-go
    const patchesDir = path.join(sourceDir, 'patches')
    if (fs.existsSync(patchesDir)) {
      const count = await applyPatches(patchesDir, tsGoDir)
      if (count > 0) {
        console.log(`Applied ${count} patches`)
      }
    }

    // copy internal/collections from typescript-go (required by tsgolint, done by `just init`)
    const collectionsDir = path.join(sourceDir, 'internal', 'collections')
    const tsGoCollections = path.join(tsGoDir, 'internal', 'collections')
    if (fs.existsSync(tsGoCollections)) {
      fs.mkdirSync(collectionsDir, { recursive: true })
      const files = fs.readdirSync(tsGoCollections).filter((f) => {
        return f.endsWith('.go') && !f.endsWith('_test.go')
      })
      for (const file of files) {
        fs.copyFileSync(path.join(tsGoCollections, file), path.join(collectionsDir, file))
      }
    }

    // write ready marker
    fs.writeFileSync(readyMarker, new Date().toISOString())
    console.log('tsgolint source ready')
  } catch (err) {
    // clean up partial download so next run starts fresh
    if (fs.existsSync(sourceDir)) {
      fs.rmSync(sourceDir, { recursive: true })
    }
    throw err
  }

  return sourceDir
}

export function cachedBinaryExists(contentHash: string): boolean {
  const binPath = getBinaryPath(contentHash)
  try {
    fs.accessSync(binPath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
