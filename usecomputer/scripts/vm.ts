// Unified CLI for running commands inside a UTM Linux VM.
//
// Subcommands:
//   vm exec <command>  — run a shell command in the guest
//   vm sync            — sync git-tracked files to the guest
//   vm test            — sync, build, typecheck, run tests
//
// Uses UTM's AppleScript API with output capturing, since utmctl exec
// does not reliably print guest output. HOME is set automatically on
// every command. Pass --x11 (or use `vm test`) for DISPLAY/XAUTHORITY.

import childProcess from 'node:child_process'
import path from 'node:path'
import { goke } from 'goke'
import { z } from 'zod'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const defaultVmName = 'Linux'
const defaultGuestDir = '/root/usecomputer'

// qemu-guest-agent runs as root but doesn't set HOME, DISPLAY, or XAUTHORITY.
const baseEnv = 'export HOME=/root'
const x11Env = [
  'export DISPLAY=:0',
  'export XAUTHORITY=$(find /run/user -name ".mutter-Xwaylandauth.*" 2>/dev/null | head -1)',
].join(' && ')

// ---------------------------------------------------------------------------
// Core: AppleScript-based VM command execution
// ---------------------------------------------------------------------------

function escapeAppleScript({ value }: { value: string }): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function buildAppleScript({ vmName, shellCommand }: { vmName: string; shellCommand: string }): string {
  const escapedVm = escapeAppleScript({ value: vmName })
  const escapedCmd = escapeAppleScript({ value: shellCommand })
  return [
    'tell application "UTM"',
    `  set vm to virtual machine named "${escapedVm}"`,
    '  set lf to (ASCII character 10)',
    `  tell (execute of vm at "bash" with arguments {"-lc", "${escapedCmd}"} with output capturing)`,
    '    repeat',
    '      set res to get result',
    '      if exited of res then exit repeat',
    '      delay 0.1',
    '    end repeat',
    '    set exitCode to exit code of res',
    '    set stdoutText to output text of res',
    '    set stderrText to error text of res',
    '    return (exitCode as text) & lf & "---STDOUT---" & lf & stdoutText & lf & "---STDERR---" & lf & stderrText',
    '  end tell',
    'end tell',
  ].join('\n')
}

function parseOutput({ raw }: { raw: string }): { exitCode: number; stdout: string; stderr: string } {
  const trimmed = raw.trimEnd()
  const stdoutMarker = '---STDOUT---'
  const stderrMarker = '---STDERR---'
  const stdoutIdx = trimmed.indexOf(stdoutMarker)
  const stderrIdx = trimmed.indexOf(stderrMarker)
  if (stdoutIdx === -1 || stderrIdx === -1) {
    return { exitCode: 0, stdout: trimmed, stderr: '' }
  }
  const exitCode = parseInt(trimmed.slice(0, stdoutIdx).trim(), 10)
  const stdout = trimmed.slice(stdoutIdx + stdoutMarker.length + 1, stderrIdx).replace(/\n$/, '')
  const stderr = trimmed.slice(stderrIdx + stderrMarker.length + 1).replace(/\n$/, '')
  return { exitCode: isNaN(exitCode) ? 0 : exitCode, stdout, stderr }
}

/** Run a shell command inside the VM, returning exit code + stdout + stderr. */
async function vmExec({
  vmName,
  command,
  x11,
}: {
  vmName: string
  command: string
  x11?: boolean
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const envPrefix = x11 ? `${baseEnv} && ${x11Env}` : baseEnv
  const fullCommand = `${envPrefix} && ${command}`
  const script = buildAppleScript({ vmName, shellCommand: fullCommand })
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn('osascript', ['-e', script], { stdio: 'pipe' })
    let output = ''
    let osascriptStderr = ''
    child.stdout.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      osascriptStderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`osascript failed (code ${String(code)}): ${osascriptStderr.trim()}`))
        return
      }
      resolve(parseOutput({ raw: output }))
    })
  })
}

/** Run a shell command inside the VM, printing stdout/stderr, exiting on failure. */
async function vmRun({ vmName, command, x11 }: { vmName: string; command: string; x11?: boolean }): Promise<void> {
  const result = await vmExec({ vmName, command, x11 })
  if (result.stdout) {
    process.stdout.write(result.stdout)
    if (!result.stdout.endsWith('\n')) {
      process.stdout.write('\n')
    }
  }
  if (result.stderr) {
    process.stderr.write(result.stderr)
    if (!result.stderr.endsWith('\n')) {
      process.stderr.write('\n')
    }
  }
  if (result.exitCode !== 0) {
    process.exit(result.exitCode)
  }
}

// ---------------------------------------------------------------------------
// Helpers for sync
// ---------------------------------------------------------------------------

function getGitTrackedFiles(): string[] {
  const result = childProcess.spawnSync('git', ['ls-files', 'usecomputer/'], {
    cwd: repoRoot,
    stdio: 'pipe',
  })
  if (result.error) {
    throw result.error
  }
  return (result.stdout?.toString() ?? '')
    .trim()
    .split('\n')
    .filter((line) => {
      return line.length > 0
    })
}

function createTarBase64({ files }: { files: string[] }): string {
  // bsdtar -s strips the usecomputer/ prefix so files extract at root level
  const result = childProcess.spawnSync(
    'bash',
    ['-c', `tar -cf - -s '|^usecomputer/||' ${files.map((f) => `'${f}'`).join(' ')} | base64`],
    { cwd: repoRoot, stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 },
  )
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`tar+base64 failed: ${result.stderr?.toString()}`)
  }
  return result.stdout.toString().trim()
}

async function syncFiles({ vmName, guestDir }: { vmName: string; guestDir: string }): Promise<void> {
  process.stdout.write('Collecting git-tracked files...\n')
  const files = getGitTrackedFiles()
  process.stdout.write(`  ${String(files.length)} files\n`)

  process.stdout.write('Creating tar archive...\n')
  const tarBase64 = createTarBase64({ files })
  const sizeMb = ((tarBase64.length * 3) / 4 / 1024 / 1024).toFixed(1)
  process.stdout.write(`  ${sizeMb} MB\n`)

  await vmExec({ vmName, command: `mkdir -p '${guestDir}'` })
  await vmExec({ vmName, command: 'rm -f /tmp/usecomputer-sync.tar.b64' })

  // Transfer base64 in 60KB chunks (qemu-guest-agent arg limit is ~128KB)
  const chunkSize = 60_000
  const totalChunks = Math.ceil(tarBase64.length / chunkSize)
  process.stdout.write(`Transferring ${String(totalChunks)} chunks...\n`)

  for (let i = 0; i < tarBase64.length; i += chunkSize) {
    const chunk = tarBase64.slice(i, i + chunkSize)
    const n = Math.floor(i / chunkSize) + 1
    process.stdout.write(`  ${String(n)}/${String(totalChunks)}\r`)
    await vmExec({ vmName, command: `printf '%s' '${chunk}' >> /tmp/usecomputer-sync.tar.b64` })
  }
  process.stdout.write(`  ${String(totalChunks)}/${String(totalChunks)}\n`)

  await vmExec({
    vmName,
    command: `base64 -d /tmp/usecomputer-sync.tar.b64 | tar -xf - -C '${guestDir}' && rm -f /tmp/usecomputer-sync.tar.b64`,
  })
  process.stdout.write(`Synced ${String(files.length)} files to ${vmName}:${guestDir}\n`)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const cli = goke('vm')

cli
  .option('--vm [name]', z.string().default(defaultVmName).describe('UTM virtual machine name'))
  .option('--guest-dir [dir]', z.string().default(defaultGuestDir).describe('Guest directory for usecomputer files'))

// --- exec ---

cli
  .command('exec [...command]', 'Run a shell command inside the VM')
  .option('--x11', 'Set DISPLAY and XAUTHORITY for X11/XWayland access')
  .action(async (command, options) => {
    // pnpm passes `--` before user args, so words may land in options['--']
    const passthrough = (options['--'] ?? []) as string[]
    const allWords = [...command, ...passthrough]

    // Extract --vm/--x11 from passthrough if goke didn't parse them
    let vmName: string = options.vm
    let x11: boolean = options.x11 ?? false
    const filtered: string[] = []
    for (let i = 0; i < allWords.length; i++) {
      if (allWords[i] === '--vm' && i + 1 < allWords.length) {
        vmName = allWords[i + 1]!
        i++
      } else if (allWords[i] === '--x11') {
        x11 = true
      } else {
        filtered.push(allWords[i]!)
      }
    }

    const shellCommand = filtered.join(' ')
    if (!shellCommand) {
      cli.outputHelp()
      process.exit(1)
    }
    await vmRun({ vmName, command: shellCommand, x11 })
  })

// --- sync ---

cli
  .command('sync', 'Sync git-tracked files to the VM (replaces git clone)')
  .action(async (options) => {
    await syncFiles({ vmName: options.vm, guestDir: options.guestDir })
  })

// --- test ---

cli
  .command('test', 'Sync, build, typecheck, and run tests in the VM')
  .option('--setup', 'Install system deps first (node, pnpm, zig, X11 libs)')
  .option('--test-file [path]', z.string().describe('Run one test file instead of full suite'))
  .option('--test-name [pattern]', z.string().describe('Filter test names (used with --test-file)'))
  .example('# First time setup + test')
  .example('pnpm vm test --setup')
  .example('# Quick re-test after code changes')
  .example('pnpm vm test')
  .example('# Run a single test file')
  .example('pnpm vm test --test-file src/bridge-contract.test.ts')
  .action(async (options) => {
    const { vm, guestDir } = options

    if (options.setup) {
      process.stdout.write('\n==> Installing system dependencies\n')
      await vmRun({
        vmName: vm,
        command: [
          'export DEBIAN_FRONTEND=noninteractive',
          'sudo apt-get update -qq',
          'sudo apt-get install -y -qq curl build-essential pkg-config libx11-dev libxext-dev libxtst-dev libxrandr-dev libpng-dev',
          'if ! command -v node >/dev/null; then curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y -qq nodejs; fi',
          'if ! command -v pnpm >/dev/null; then sudo npm install -g pnpm; fi',
          [
            'if ! command -v zig >/dev/null; then',
            '  ARCH=$(uname -m)',
            '  curl -LO "https://ziglang.org/download/0.15.2/zig-$ARCH-linux-0.15.2.tar.xz"',
            '  sudo tar -xJf "zig-$ARCH-linux-0.15.2.tar.xz" -C /opt',
            '  sudo ln -sf "/opt/zig-$ARCH-linux-0.15.2/zig" /usr/local/bin/zig',
            '  rm -f "zig-$ARCH-linux-0.15.2.tar.xz"',
            'fi',
          ].join('\n'),
          'echo "node $(node --version), pnpm $(pnpm --version), zig $(zig version)"',
        ].join(' && '),
      })
    }

    process.stdout.write('\n==> Syncing files to VM\n')
    await syncFiles({ vmName: vm, guestDir })

    process.stdout.write('\n==> Installing npm dependencies\n')
    await vmRun({ vmName: vm, command: `cd '${guestDir}' && pnpm install --filter usecomputer 2>&1 | tail -5` })

    process.stdout.write('\n==> Building zig native module\n')
    await vmRun({ vmName: vm, command: `cd '${guestDir}' && zig build` })

    process.stdout.write('\n==> Typechecking\n')
    await vmRun({ vmName: vm, command: `cd '${guestDir}' && npx tsc --noEmit` })

    process.stdout.write('\n==> Running tests\n')
    const testParts = ['npx', 'vitest', '--run']
    if (options.testFile) {
      testParts.push(options.testFile)
    }
    if (options.testName) {
      testParts.push('-t', `'${options.testName}'`)
    }
    await vmRun({ vmName: vm, command: `cd '${guestDir}' && ${testParts.join(' ')}`, x11: true })

    process.stdout.write('\nAll checks passed.\n')
  })

cli.help()
cli.parse()
