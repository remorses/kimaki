// Execute a command inside an already-running UTM VM and print stdout/stderr.
// Uses UTM's AppleScript API with output capturing, since utmctl exec does not
// reliably print guest output.
//
// Usage: pnpm vm:exec -- [--vm <name>] <command...>
// Example: pnpm vm:exec -- echo ciao
// Example: pnpm vm:exec -- --vm Ubuntu ls -la /tmp

import childProcess from 'node:child_process'

const defaultVmName = 'Linux'

type ParsedArgs = {
  vmName: string
  guestCommand: string[]
}

function parseArgs({ argv }: { argv: string[] }): ParsedArgs {
  let vmName = defaultVmName
  // pnpm passes '--' as a literal arg, skip it
  const args = argv[0] === '--' ? argv.slice(1) : [...argv]
  const guestCommand: string[] = []

  while (args.length > 0) {
    const current = args.shift()!
    if (current === '--vm' && args.length > 0) {
      vmName = args.shift()!
      continue
    }
    if (current === '--help' || current === '-h') {
      process.stdout.write(`Usage: pnpm vm:exec -- [--vm <name>] <command...>\n`)
      process.stdout.write(`Default VM: ${defaultVmName}\n`)
      process.exit(0)
    }
    guestCommand.push(current)
  }

  if (guestCommand.length === 0) {
    throw new Error('No command provided. Usage: pnpm vm:exec -- <command...>')
  }

  return { vmName, guestCommand }
}

function escapeAppleScriptString({ value }: { value: string }): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function buildAppleScript({ vmName, shellCommand }: { vmName: string; shellCommand: string }): string {
  const escapedVm = escapeAppleScriptString({ value: vmName })
  const escapedCmd = escapeAppleScriptString({ value: shellCommand })

  // AppleScript uses `linefeed` for actual newline characters in strings.
  // Using string literals like "\\n" produces literal backslash-n, not newlines.
  return [
    'tell application "UTM"',
    `  set vm to virtual machine named "${escapedVm}"`,
    `  set lf to (ASCII character 10)`,
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

async function runAppleScript({ script }: { script: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = childProcess.spawn('osascript', ['-e', script], {
      stdio: 'pipe',
    })

    let output = ''
    let osascriptStderr = ''

    child.stdout.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      osascriptStderr += chunk.toString()
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`osascript failed (code ${String(code)}): ${osascriptStderr.trim()}`))
        return
      }

      // AppleScript returns: "exitCode\n---STDOUT---\nstdout\n---STDERR---\nstderr"
      // Guest output may contain trailing newlines, so markers can be preceded
      // by extra newlines. Use indexOf on the marker text without surrounding \n.
      const raw = output.trimEnd()
      const stdoutMarkerText = '---STDOUT---'
      const stderrMarkerText = '---STDERR---'
      const stdoutIndex = raw.indexOf(stdoutMarkerText)
      const stderrIndex = raw.indexOf(stderrMarkerText)

      if (stdoutIndex === -1 || stderrIndex === -1) {
        resolve({ exitCode: 0, stdout: raw, stderr: '' })
        return
      }

      const exitCodeStr = raw.slice(0, stdoutIndex).trim()
      const exitCode = parseInt(exitCodeStr, 10)
      // skip the marker text and the newline after it
      const stdoutStart = stdoutIndex + stdoutMarkerText.length + 1
      const stdoutRaw = raw.slice(stdoutStart, stderrIndex)
      const stdout = stdoutRaw.replace(/\n$/, '')
      const stderrStart = stderrIndex + stderrMarkerText.length + 1
      const stderrRaw = raw.slice(stderrStart)
      const stderr = stderrRaw.replace(/\n$/, '')

      resolve({ exitCode: isNaN(exitCode) ? 0 : exitCode, stdout, stderr })
    })
  })
}

async function main(): Promise<void> {
  const { vmName, guestCommand } = parseArgs({ argv: process.argv.slice(2) })
  const shellCommand = guestCommand.join(' ')

  const result = await runAppleScript({
    script: buildAppleScript({ vmName, shellCommand }),
  })

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

  process.exit(result.exitCode)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
