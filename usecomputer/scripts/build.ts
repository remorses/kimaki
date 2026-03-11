// Cross-target builder for usecomputer native Zig artifacts.

import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

type Target = {
  name: string
  zigTarget: string
}

const rootDirectory = path.resolve(import.meta.dirname, '..')
const distDirectory = path.join(rootDirectory, 'dist')
const zigOutputDirectory = path.join(rootDirectory, 'zig-out', 'lib')

const targets: Target[] = [
  { name: 'darwin-arm64', zigTarget: 'aarch64-macos' },
  { name: 'darwin-x64', zigTarget: 'x86_64-macos' },
  { name: 'linux-arm64', zigTarget: 'aarch64-linux-gnu' },
  { name: 'linux-x64', zigTarget: 'x86_64-linux-gnu' },
  { name: 'win32-x64', zigTarget: 'x86_64-windows-gnu' },
]

function runCommand({ command, args, cwd }: { command: string; args: string[]; cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd,
      stdio: 'inherit',
    })
    child.on('error', (error) => {
      reject(error)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} failed with code ${String(code)}`))
    })
  })
}

function resolveNativeBinaryPath(): Error | string {
  const candidates = ['usecomputer.node', 'usecomputer.dll', 'libusecomputer.so'].map((fileName) => {
    return path.join(zigOutputDirectory, fileName)
  })
  const found = candidates.find((candidate) => {
    return fs.existsSync(candidate)
  })
  if (!found) {
    return new Error(`No native artifact found in ${zigOutputDirectory}`)
  }
  return found
}

async function buildTarget({ target }: { target: Target }): Promise<void> {
  fs.rmSync(path.join(rootDirectory, 'zig-out'), { recursive: true, force: true })
  await runCommand({
    command: 'zig',
    args: ['build', '-Doptimize=ReleaseFast', `-Dtarget=${target.zigTarget}`],
    cwd: rootDirectory,
  })
  const source = resolveNativeBinaryPath()
  if (source instanceof Error) {
    throw source
  }
  const targetDirectory = path.join(distDirectory, target.name)
  fs.mkdirSync(targetDirectory, { recursive: true })
  fs.copyFileSync(source, path.join(targetDirectory, 'usecomputer.node'))
}

async function main(): Promise<void> {
  const requestedTargets = process.argv.slice(2)
  const selectedTargets = requestedTargets.length
    ? targets.filter((target) => {
        return requestedTargets.includes(target.name)
      })
    : targets

  if (selectedTargets.length === 0) {
    throw new Error(`No matching target. Available: ${targets.map((target) => target.name).join(', ')}`)
  }

  for (const target of selectedTargets) {
    await buildTarget({ target })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
