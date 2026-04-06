// Cross-platform startup service registration for kimaki daemon.
// Vendored from startup-run (MIT, github.com/vilicvane/startup-run) with
// significant simplifications: no abstract classes, no fs-extra, no winreg
// npm dep, no separate daemon process (kimaki's bin.ts already handles
// respawn/crash-loop). Just writes/deletes the platform service file.
//
// macOS:   ~/Library/LaunchAgents/xyz.kimaki.plist  (launchd)
// Linux:   ~/.config/autostart/kimaki.desktop       (XDG autostart)
// Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run  (registry)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execAsync } from './worktrees.js'

const SERVICE_NAME = 'xyz.kimaki'

function getServiceFilePath(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(
        os.homedir(),
        'Library',
        'LaunchAgents',
        `${SERVICE_NAME}.plist`,
      )
    case 'linux':
      return path.join(
        os.homedir(),
        '.config',
        'autostart',
        'kimaki.desktop',
      )
    case 'win32':
      // No file — registry key, return a descriptive string for status display
      return 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\kimaki'
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Shell-escape a string for use in a Linux .desktop Exec= line.
// Wraps in double quotes if it contains spaces or special chars.
function shellEscape(value: string): string {
  if (/^[a-zA-Z0-9._/=-]+$/.test(value)) {
    return value
  }
  return `"${value.replace(/"/g, '\\"')}"`
}

function buildMacOSPlist({
  command,
  args,
}: {
  command: string
  args: string[]
}): string {
  const segments = [command, ...args]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
${segments.map((s) => `    <string>${escapeXml(s)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`
}

function buildLinuxDesktop({
  command,
  args,
}: {
  command: string
  args: string[]
}): string {
  const execLine = [command, ...args].map(shellEscape).join(' ')
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Kimaki
Comment=Kimaki Discord Bot Daemon
Exec=${execLine}
StartupNotify=false
Terminal=false
`
}

export type StartupServiceOptions = {
  command: string
  args: string[]
}

/**
 * Register kimaki to start on user login.
 * Writes the appropriate service file for the current platform.
 */
export async function enableStartupService({
  command,
  args,
}: StartupServiceOptions): Promise<void> {
  const platform = process.platform

  if (platform === 'darwin') {
    const filePath = getServiceFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, buildMacOSPlist({ command, args }))
  } else if (platform === 'linux') {
    const filePath = getServiceFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, buildLinuxDesktop({ command, args }))
  } else if (platform === 'win32') {
    const execLine = [command, ...args]
      .map((s) => {
        return s.includes(' ') ? `"${s}"` : s
      })
      .join(' ')
    await execAsync(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v kimaki /t REG_SZ /d "${execLine}" /f`,
    )
  } else {
    throw new Error(`Unsupported platform: ${platform}`)
  }
}

/**
 * Unregister kimaki from user login startup.
 */
export async function disableStartupService(): Promise<void> {
  const platform = process.platform

  if (platform === 'darwin' || platform === 'linux') {
    const filePath = getServiceFilePath()
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } else if (platform === 'win32') {
    await execAsync(
      `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v kimaki /f`,
    ).catch(() => {
      // Key may not exist, ignore
    })
  } else {
    throw new Error(`Unsupported platform: ${platform}`)
  }
}

/**
 * Check if kimaki is registered as a startup service.
 */
export async function isStartupServiceEnabled(): Promise<boolean> {
  const platform = process.platform

  if (platform === 'darwin' || platform === 'linux') {
    return fs.existsSync(getServiceFilePath())
  }

  if (platform === 'win32') {
    const result = await execAsync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v kimaki`,
    ).catch(() => {
      return null
    })
    return result !== null
  }

  return false
}

/**
 * Get a human-readable description of the service location for status display.
 */
export function getServiceLocationDescription(): string {
  const platform = process.platform
  if (platform === 'darwin') {
    return `launchd: ${getServiceFilePath()}`
  }
  if (platform === 'linux') {
    return `XDG autostart: ${getServiceFilePath()}`
  }
  if (platform === 'win32') {
    return `registry: ${getServiceFilePath()}`
  }
  return `unsupported platform: ${platform}`
}
