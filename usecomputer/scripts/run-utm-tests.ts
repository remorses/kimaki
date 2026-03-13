// Orchestrates cloning, setup, build, and test execution in an already-running UTM guest.

import childProcess from 'node:child_process'
import path from 'node:path'

type ScriptOptions = {
  vmName: string
  repoUrl: string
  guestRootDir: string
  ref: string
  refWasExplicit: boolean
  setup: boolean
  testFile?: string
  testName?: string
}

type ExecAsyncOptions = {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  streamOutput?: boolean
}

type ExecAsyncResult = {
  stdout: string
  stderr: string
}

const rootDirectory = path.resolve(import.meta.dirname, '..')
const utmctlPath = '/Applications/UTM.app/Contents/MacOS/utmctl'
const defaultRepoUrl = 'https://github.com/remorses/kimaki.git'
const defaultGuestRootDir = '~/kimaki'
const defaultGitRef = 'main'
const defaultZigVersion = '0.15.2'

async function execAsync({
  command,
  args,
  cwd,
  env,
  input,
  streamOutput = false,
}: ExecAsyncOptions): Promise<ExecAsyncResult> {
  return await new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd,
      env,
      stdio: 'pipe',
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stdout += text
      if (streamOutput) {
        process.stdout.write(text)
      }
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderr += text
      if (streamOutput) {
        process.stderr.write(text)
      }
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(`${command} ${args.join(' ')} failed with code ${String(code)}`))
    })

    if (input) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })
}

function parseArgs({ argv }: { argv: string[] }): ScriptOptions {
  let vmName = ''
  let repoUrl = defaultRepoUrl
  let guestRootDir = defaultGuestRootDir
  let ref = ''
  let refWasExplicit = false
  let setup = false
  let testFile: string | undefined
  let testName: string | undefined

  const args = [...argv]
  while (args.length > 0) {
    const current = args.shift()
    if (!current) {
      continue
    }
    if (current === '--vm') {
      vmName = args.shift() ?? ''
      continue
    }
    if (current === '--repo') {
      repoUrl = args.shift() ?? defaultRepoUrl
      continue
    }
    if (current === '--guest-root-dir') {
      guestRootDir = args.shift() ?? defaultGuestRootDir
      continue
    }
    if (current === '--ref') {
      ref = args.shift() ?? ''
      refWasExplicit = true
      continue
    }
    if (current === '--setup') {
      setup = true
      continue
    }
    if (current === '--test-file') {
      testFile = args.shift()
      continue
    }
    if (current === '--test-name') {
      testName = args.shift()
      continue
    }
    if (current === '--help' || current === '-h') {
      printHelp()
      process.exit(0)
    }
    throw new Error(`Unknown argument: ${current}`)
  }

  if (!vmName) {
    throw new Error('Missing required --vm <name>')
  }

  return {
    vmName,
    repoUrl,
    guestRootDir,
    ref: ref || defaultGitRef,
    refWasExplicit,
    setup,
    testFile,
    testName,
  }
}

function printHelp(): void {
  process.stdout.write(`Run usecomputer checks inside an already-running UTM VM.\n\n`)
  process.stdout.write(`Usage:\n`)
  process.stdout.write(`  pnpm vm:test:utm -- --vm ubuntu-dev [--setup] [--ref <git-ref>] [--test-file <path>] [--test-name <pattern>]\n\n`)
  process.stdout.write(`Options:\n`)
  process.stdout.write(`  --vm <name>             UTM virtual machine name or UUID\n`)
  process.stdout.write(`  --repo <url>            Git repository URL to clone (default: ${defaultRepoUrl})\n`)
  process.stdout.write(`  --guest-root-dir <dir>  Guest directory where the repo should live (default: ${defaultGuestRootDir})\n`)
  process.stdout.write(`  --ref <git-ref>         Git ref to checkout in the guest (default: local HEAD, fallback ${defaultGitRef})\n`)
  process.stdout.write(`  --setup                 Install Ubuntu guest dependencies before cloning/building\n`)
  process.stdout.write(`  --test-file <path>      Run one test file instead of the full test suite\n`)
  process.stdout.write(`  --test-name <pattern>   Pass a Vitest name filter when used with --test-file\n`)
}

async function resolveDefaultGitRef(): Promise<string> {
  const result = await execAsync({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: rootDirectory,
  }).catch(() => {
    return new Error('failed to resolve local git ref')
  })
  if (result instanceof Error) {
    return defaultGitRef
  }
  const ref = result.stdout.trim()
  return ref || defaultGitRef
}

function repoDirectoryName({ repoUrl }: { repoUrl: string }): string {
  const withoutTrailingSlash = repoUrl.endsWith('/') ? repoUrl.slice(0, -1) : repoUrl
  const lastSegment = withoutTrailingSlash.split('/').at(-1) || 'kimaki'
  return lastSegment.endsWith('.git') ? lastSegment.slice(0, -4) : lastSegment
}

function buildGuestShellCommand({ script }: { script: string }): string[] {
  return ['exec', '--hide', options.vmName, '--cmd', 'bash', '-lc', script]
}

let options: ScriptOptions

async function runGuestCommand({ script, description }: { script: string; description: string }): Promise<void> {
  process.stdout.write(`\n==> ${description}\n`)
  await execAsync({
    command: utmctlPath,
    args: buildGuestShellCommand({ script }),
    streamOutput: true,
  })
}

async function captureUtmCommand({ args }: { args: string[] }): Promise<string> {
  const result = await execAsync({
    command: utmctlPath,
    args,
  })
  return result.stdout.trim()
}

async function assertVmRunning(): Promise<void> {
  const status = await captureUtmCommand({
    args: ['status', '--hide', options.vmName],
  })
  const normalized = status.toLowerCase()
  if (normalized.includes('started') || normalized.includes('running') || normalized.includes('resumed')) {
    process.stdout.write(`VM status: ${status}\n`)
    return
  }
  throw new Error(`UTM VM is not running: ${status || 'unknown status'}`)
}

function buildSetupScript(): string {
  return [
    'set -euo pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    'sudo apt-get update',
    'sudo apt-get install -y ca-certificates curl xz-utils git gh build-essential pkg-config libx11-dev libxext-dev libxtst-dev libpng-dev qemu-guest-agent spice-vdagent nodejs npm',
    'if ! command -v pnpm >/dev/null 2>&1; then sudo npm install -g pnpm; fi',
    `if ! command -v zig >/dev/null 2>&1; then
ARCH=$(dpkg --print-architecture)
case "$ARCH" in
  amd64) ZIG_ARCH="x86_64" ;;
  arm64) ZIG_ARCH="aarch64" ;;
  *) echo "Unsupported Ubuntu architecture for Zig: $ARCH" >&2; exit 1 ;;
esac
mkdir -p "$HOME/.local/bin" "$HOME/.local/opt"
cd "$HOME/.local/opt"
ZIG_DIR="zig-linux-$ZIG_ARCH-${defaultZigVersion}"
if [ ! -d "$ZIG_DIR" ]; then
  curl -L -o "zig.tar.xz" "https://ziglang.org/download/${defaultZigVersion}/zig-linux-$ZIG_ARCH-${defaultZigVersion}.tar.xz"
  rm -rf "$ZIG_DIR"
  tar -xf zig.tar.xz
  rm -f zig.tar.xz
fi
ln -sf "$HOME/.local/opt/$ZIG_DIR/zig" "$HOME/.local/bin/zig"
if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.profile" 2>/dev/null; then
  printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.profile"
fi
fi`,
    'sudo systemctl enable qemu-guest-agent || true',
    'sudo systemctl start qemu-guest-agent || true',
    'sudo systemctl enable spice-vdagent || true',
    'sudo systemctl start spice-vdagent || true',
    'export PATH="$HOME/.local/bin:$PATH"',
    'command -v git',
    'command -v gh',
    'command -v node',
    'command -v pnpm',
    'command -v zig',
  ].join('\n')
}

function buildPrepareRepoScript({ repoDir, packageDir }: { repoDir: string; packageDir: string }): string {
  return [
    'set -euo pipefail',
    'export PATH="$HOME/.local/bin:$PATH"',
    `mkdir -p ${shellQuote({ value: options.guestRootDir })}`,
    `if [ ! -d ${shellQuote({ value: `${repoDir}/.git` })} ]; then git clone ${shellQuote({ value: options.repoUrl })} ${shellQuote({ value: repoDir })}; fi`,
    `cd ${shellQuote({ value: repoDir })}`,
    'git fetch --all --tags',
    `git checkout ${shellQuote({ value: options.ref })}`,
    `cd ${shellQuote({ value: packageDir })}`,
    'pnpm install',
  ].join('\n')
}

function buildTestScript({ packageDir }: { packageDir: string }): string {
  const testCommand = (() => {
    if (!options.testFile) {
      return 'pnpm test'
    }
    const parts = ['pnpm', 'test', shellQuote({ value: options.testFile })]
    if (options.testName) {
      parts.push('-t', shellQuote({ value: options.testName }))
    }
    return parts.join(' ')
  })()

  return [
    'set -euo pipefail',
    'export PATH="$HOME/.local/bin:$PATH"',
    `cd ${shellQuote({ value: packageDir })}`,
    'pnpm build:zig',
    'pnpm typecheck',
    testCommand,
  ].join('\n')
}

function shellQuote({ value }: { value: string }): string {
  return `'${value.replaceAll(`'`, `'"'"'`)}'`
}

async function main(): Promise<void> {
  options = parseArgs({ argv: process.argv.slice(2) })
  if (!options.refWasExplicit) {
    options = {
      ...options,
      ref: await resolveDefaultGitRef(),
    }
  }

  await assertVmRunning()

  const repoDirName = repoDirectoryName({ repoUrl: options.repoUrl })
  const repoDir = `${options.guestRootDir}/${repoDirName}`
  const packageDir = `${repoDir}/usecomputer`

  if (options.setup) {
    await runGuestCommand({
      description: 'Installing Ubuntu guest dependencies',
      script: buildSetupScript(),
    })
  }

  await runGuestCommand({
    description: 'Cloning or updating the repo in the guest',
    script: buildPrepareRepoScript({ repoDir, packageDir }),
  })

  await runGuestCommand({
    description: 'Running usecomputer build and tests in the guest',
    script: buildTestScript({ packageDir }),
  })
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
