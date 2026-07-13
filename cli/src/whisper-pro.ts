// "Pro" local transcription — auto-provisioned faster-whisper large-v3.
//
// The built-in ONNX tier (whisper-local.ts) tops out at large-v3-turbo on CPU.
// This module provisions the full GPU-class stack with zero user setup, using
// `uv` (a single static binary with no prerequisites) to bootstrap a managed
// Python + faster-whisper (CTranslate2), then runs a small bundled HTTP server
// exposing /v1/audio/transcriptions. The service itself is managed by the
// existing whisper-service lifecycle (whisper.json + /whisper-start|stop).
//
// Device selection: NVIDIA GPU → CUDA (cuDNN/cuBLAS wheels installed and their
// lib dirs baked into the launch command); otherwise CPU int8, which is still
// fast enough for voice notes on strong CPUs. Model downloads (~3 GB) go to the
// standard HF cache and happen on first server start.
import * as errore from 'errore'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getDataDir } from './config.js'
import { createLogger, LogPrefix } from './logger.js'
import { detectQueueIntent } from './whisper-local.js'
import type { TranscriptionResult } from './voice.js'

const logger = createLogger(LogPrefix.VOICE)

export class WhisperProError extends errore.createTaggedError({
  name: 'WhisperProError',
  message: '$reason',
}) {}

// Pinned uv release; all five assets verified to exist for this tag.
const UV_VERSION = '0.11.28'

export const WHISPER_PRO_PORT = 7071
export const WHISPER_PRO_MODEL = 'large-v3'

function proDir(): string {
  return path.join(getDataDir(), 'whisper-pro')
}

function uvBinPath(): string {
  return path.join(proDir(), 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
}

function venvDir(): string {
  return path.join(proDir(), 'venv')
}

function venvPython(): string {
  return process.platform === 'win32'
    ? path.join(venvDir(), 'Scripts', 'python.exe')
    : path.join(venvDir(), 'bin', 'python')
}

function serverScriptPath(): string {
  return path.join(proDir(), 'whisper-pro-server.py')
}

function uvAssetName(): WhisperProError | string {
  const { platform, arch } = process
  if (platform === 'linux' && arch === 'x64') return 'uv-x86_64-unknown-linux-gnu.tar.gz'
  if (platform === 'linux' && arch === 'arm64') return 'uv-aarch64-unknown-linux-gnu.tar.gz'
  if (platform === 'darwin' && arch === 'arm64') return 'uv-aarch64-apple-darwin.tar.gz'
  if (platform === 'darwin' && arch === 'x64') return 'uv-x86_64-apple-darwin.tar.gz'
  if (platform === 'win32' && arch === 'x64') return 'uv-x86_64-pc-windows-msvc.zip'
  return new WhisperProError({ reason: `unsupported platform for Pro tier: ${platform}/${arch}` })
}

function run({
  command,
  args,
  cwd,
  timeoutMs,
}: {
  command: string
  args: string[]
  cwd?: string
  timeoutMs?: number
}): Promise<Error | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: 'ignore' })
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill()
          resolve(new Error(`${command} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      : null
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      resolve(e)
    })
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer)
      resolve(code === 0 ? null : new Error(`${command} exited with code ${code}`))
    })
  })
}

async function downloadUv({
  onProgress,
}: {
  onProgress?: (message: string) => void
}): Promise<WhisperProError | null> {
  if (fs.existsSync(uvBinPath())) return null

  const asset = uvAssetName()
  if (asset instanceof Error) return asset

  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`
  onProgress?.('Downloading the provisioning tool (uv)…')

  const binDir = path.join(proDir(), 'bin')
  fs.mkdirSync(binDir, { recursive: true })

  const archivePath = path.join(proDir(), asset)
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch(
    (e) => new WhisperProError({ reason: `uv download failed: ${String(e)}`, cause: e }),
  )
  if (res instanceof Error) return res
  if (!res.ok) return new WhisperProError({ reason: `uv download failed: HTTP ${res.status}` })

  const bytes = Buffer.from(await res.arrayBuffer())
  const wrote = errore.try(
    () => fs.writeFileSync(archivePath, bytes),
    (e) => new WhisperProError({ reason: `failed to write uv archive: ${String(e)}`, cause: e }),
  )
  if (wrote instanceof Error) return wrote

  // Extract: tar for unix archives, PowerShell Expand-Archive for the Windows zip.
  const extractError = await (async () => {
    if (asset.endsWith('.zip')) {
      return run({
        command: 'powershell.exe',
        args: ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${binDir}'`],
        timeoutMs: 120_000,
      })
    }
    return run({
      command: 'tar',
      args: ['-xzf', archivePath, '-C', binDir, '--strip-components=1'],
      timeoutMs: 120_000,
    })
  })()
  errore.try(() => fs.rmSync(archivePath, { force: true }), (e) => e as Error)
  if (extractError) {
    return new WhisperProError({ reason: `uv extract failed: ${extractError.message}`, cause: extractError })
  }

  // Windows zip may extract into a subfolder; locate uv.exe and move it up.
  if (!fs.existsSync(uvBinPath())) {
    const found = fs
      .readdirSync(binDir, { recursive: true, withFileTypes: true })
      .find((entry) => entry.isFile() && (entry.name === 'uv' || entry.name === 'uv.exe'))
    if (found) {
      fs.renameSync(path.join(found.parentPath, found.name), uvBinPath())
    }
  }
  if (!fs.existsSync(uvBinPath())) {
    return new WhisperProError({ reason: 'uv binary not found after extraction' })
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(uvBinPath(), 0o755)
  }
  return null
}

// Glob the venv's bundled nvidia lib dirs (cuDNN, cuBLAS) for LD_LIBRARY_PATH.
function nvidiaLibDirs(): string[] {
  const libRoot = path.join(venvDir(), 'lib')
  const dirs: string[] = []
  const pythons = errore.try(
    () => fs.readdirSync(libRoot).filter((d) => d.startsWith('python')),
    (e) => new WhisperProError({ reason: `venv lib read failed`, cause: e }),
  )
  if (pythons instanceof Error) return dirs
  for (const py of pythons) {
    const nvRoot = path.join(libRoot, py, 'site-packages', 'nvidia')
    if (!fs.existsSync(nvRoot)) continue
    for (const pkg of fs.readdirSync(nvRoot)) {
      const lib = path.join(nvRoot, pkg, 'lib')
      if (fs.existsSync(lib)) dirs.push(lib)
    }
  }
  return dirs
}

/**
 * Build the launch command for the managed lifecycle (whisper.json). On Linux
 * the cuDNN lib paths must be on LD_LIBRARY_PATH before the process starts, so
 * they are baked into the shell command; on Windows the server script adds DLL
 * dirs itself; macOS runs CPU int8 and needs nothing.
 */
export function whisperProLaunchCommand({ useCuda }: { useCuda: boolean }): string {
  const python = venvPython()
  const script = serverScriptPath()
  const base = `"${python}" "${script}" --port ${WHISPER_PRO_PORT} --model ${WHISPER_PRO_MODEL}`
  if (useCuda && process.platform !== 'win32') {
    const libs = nvidiaLibDirs()
    if (libs.length > 0) {
      return `LD_LIBRARY_PATH="${libs.join(':')}:$LD_LIBRARY_PATH" ${base}`
    }
  }
  return base
}

/**
 * Transcribe audio via a direct /v1/audio/transcriptions endpoint (the Pro
 * server, or any compatible one). Plain multipart POST — no impersonation of
 * chat-completions needed.
 */
export async function transcribeViaEndpoint({
  audio,
  mediaType,
  endpointUrl,
}: {
  audio: Buffer
  mediaType: string
  endpointUrl: string
}): Promise<WhisperProError | TranscriptionResult> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: mediaType }), 'voice.ogg')

  const url = `${endpointUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  }).catch((e) => new WhisperProError({ reason: `transcription endpoint unreachable: ${String(e)}`, cause: e }))
  if (res instanceof Error) return res
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return new WhisperProError({ reason: `transcription endpoint HTTP ${res.status}: ${body.slice(0, 200)}` })
  }

  const data = (await res.json().catch(
    (e) => new WhisperProError({ reason: 'invalid endpoint response', cause: e }),
  )) as { text?: string } | WhisperProError
  if (data instanceof WhisperProError) return data

  const text = data.text?.trim() ?? ''
  if (!text) return { transcription: '[inaudible audio]', queueMessage: false }
  return { ...detectQueueIntent(text) }
}

export interface WhisperProProvisionResult {
  launchCommand: string
  healthUrl: string
  endpointUrl: string
  device: 'cuda' | 'cpu'
}

/**
 * Provision the full Pro stack: uv → managed Python venv → faster-whisper (+
 * CUDA wheels when an NVIDIA GPU is present) → bundled server script. Safe to
 * re-run; every step is idempotent. The ~3 GB model downloads on first start.
 */
export async function provisionWhisperPro({
  hasNvidiaGpu,
  onProgress,
}: {
  hasNvidiaGpu: boolean
  onProgress?: (message: string) => void
}): Promise<WhisperProError | WhisperProProvisionResult> {
  fs.mkdirSync(proDir(), { recursive: true })

  const uvReady = await downloadUv({ onProgress })
  if (uvReady instanceof Error) return uvReady

  if (!fs.existsSync(venvPython())) {
    onProgress?.('Setting up a managed Python environment…')
    const venvError = await run({
      command: uvBinPath(),
      args: ['venv', '--python', '3.12', venvDir()],
      timeoutMs: 300_000,
    })
    if (venvError) {
      return new WhisperProError({ reason: `python setup failed: ${venvError.message}`, cause: venvError })
    }
  }

  onProgress?.('Installing faster-whisper (this can take a few minutes)…')
  const packages = [
    'faster-whisper',
    'fastapi',
    'uvicorn',
    'python-multipart',
    ...(hasNvidiaGpu ? ['nvidia-cudnn-cu12', 'nvidia-cublas-cu12'] : []),
  ]
  const pipError = await run({
    command: uvBinPath(),
    args: ['pip', 'install', '--python', venvPython(), ...packages],
    timeoutMs: 900_000,
  })
  if (pipError) {
    return new WhisperProError({ reason: `dependency install failed: ${pipError.message}`, cause: pipError })
  }

  // Copy the bundled server script (ships in the npm package under src/assets,
  // same pattern as schema.sql).
  const assetPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'assets',
    'whisper-pro-server.py',
  )
  const copied = errore.try(
    () => fs.copyFileSync(assetPath, serverScriptPath()),
    (e) => new WhisperProError({ reason: `failed to install server script: ${String(e)}`, cause: e }),
  )
  if (copied instanceof Error) return copied

  const device = hasNvidiaGpu ? 'cuda' : 'cpu'
  logger.log(`Whisper Pro provisioned (device=${device})`)
  return {
    launchCommand: whisperProLaunchCommand({ useCuda: hasNvidiaGpu }),
    healthUrl: `http://127.0.0.1:${WHISPER_PRO_PORT}/health`,
    endpointUrl: `http://127.0.0.1:${WHISPER_PRO_PORT}`,
    device,
  }
}
