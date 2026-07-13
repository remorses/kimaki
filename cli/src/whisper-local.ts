// Built-in local voice transcription — zero-setup path for non-technical users.
//
// Instead of requiring a self-hosted Whisper backend (Python/CUDA/ports/URLs),
// Kimaki can download and run an ONNX Whisper model IN-PROCESS on the CPU via
// @huggingface/transformers (pure Node, no Python). `/whisper-setup model:...`
// installs the runtime + downloads the model automatically; voice notes then
// transcribe locally with nothing else to configure.
//
// The inference runtime (~onnxruntime) is heavy, so it is NOT a kimaki
// dependency: it is npm-installed on demand into <data-dir>/whisper-runtime the
// first time a local model is selected, keeping the base install lean. Models
// are cached under <data-dir>/whisper-runtime/models by the HF hub cache.
import * as errore from 'errore'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { getDataDir } from './config.js'
import { convertOggToWav, convertM4aToWav, normalizeAudioMediaType } from './voice.js'
import type { TranscriptionResult } from './voice.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.VOICE)

export class LocalWhisperError extends errore.createTaggedError({
  name: 'LocalWhisperError',
  message: '$reason',
}) {}

export interface LocalWhisperModel {
  id: string
  hfModel: string
  label: string
  /** Approximate one-time download size shown to the user. */
  approxSize: string
}

export const LOCAL_WHISPER_MODELS: LocalWhisperModel[] = [
  {
    id: 'fast',
    hfModel: 'onnx-community/whisper-tiny',
    label: 'Fast',
    approxSize: '~110 MB',
  },
  {
    id: 'balanced',
    hfModel: 'onnx-community/whisper-base',
    label: 'Balanced (recommended)',
    approxSize: '~200 MB',
  },
  {
    id: 'accurate',
    hfModel: 'onnx-community/whisper-small',
    label: 'Accurate',
    approxSize: '~600 MB',
  },
]

export function getLocalWhisperModelById(id: string): LocalWhisperModel | undefined {
  return LOCAL_WHISPER_MODELS.find((m) => m.id === id)
}

function runtimeDir(): string {
  return path.join(getDataDir(), 'whisper-runtime')
}

function modelsCacheDir(): string {
  return path.join(runtimeDir(), 'models')
}

export function isLocalWhisperRuntimeInstalled(): boolean {
  return fs.existsSync(
    path.join(runtimeDir(), 'node_modules', '@huggingface', 'transformers', 'package.json'),
  )
}

/**
 * npm-install the inference runtime into <data-dir>/whisper-runtime (one-time).
 * Kept out of kimaki's own dependencies because onnxruntime is large.
 */
export async function installLocalWhisperRuntime(): Promise<LocalWhisperError | null> {
  if (isLocalWhisperRuntimeInstalled()) return null

  const dir = runtimeDir()
  const prepared = errore.try(
    () => {
      fs.mkdirSync(dir, { recursive: true })
      const pkgPath = path.join(dir, 'package.json')
      if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(
          pkgPath,
          JSON.stringify({ name: 'kimaki-whisper-runtime', private: true }, null, 2) + '\n',
        )
      }
    },
    (e) => new LocalWhisperError({ reason: `failed to prepare runtime dir: ${String(e)}`, cause: e }),
  )
  if (prepared instanceof Error) return prepared

  logger.log('Installing local whisper runtime (@huggingface/transformers)...')
  const exitError = await new Promise<Error | null>((resolve) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund', '@huggingface/transformers@^3'], {
      cwd: dir,
      shell: true,
      stdio: 'ignore',
    })
    child.on('error', (e) => resolve(e))
    child.on('exit', (code) => resolve(code === 0 ? null : new Error(`npm install exited with code ${code}`)))
  })
  if (exitError) {
    return new LocalWhisperError({
      reason: `runtime install failed: ${exitError.message}`,
      cause: exitError,
    })
  }
  if (!isLocalWhisperRuntimeInstalled()) {
    return new LocalWhisperError({ reason: 'runtime install completed but package not found' })
  }
  return null
}

// The ASR pipeline is cached per model so the (RAM-resident) weights load once.
let cachedPipeline: { hfModel: string; asr: (audio: Float32Array, options?: object) => Promise<unknown> } | null = null

async function getPipeline({
  hfModel,
  onProgress,
}: {
  hfModel: string
  onProgress?: (message: string) => void
}): Promise<LocalWhisperError | ((audio: Float32Array, options?: object) => Promise<unknown>)> {
  if (cachedPipeline?.hfModel === hfModel) return cachedPipeline.asr

  // Import the package's NODE entry (dist/transformers.node.mjs) — the default
  // web bundle lacks the onnxruntime-node binding and cannot run inference.
  const entry = path.join(
    runtimeDir(),
    'node_modules',
    '@huggingface',
    'transformers',
    'dist',
    'transformers.node.mjs',
  )
  if (!fs.existsSync(entry)) {
    return new LocalWhisperError({
      reason: 'local whisper runtime is not installed — run /whisper-setup again',
    })
  }

  const transformers = await import(pathToFileURL(entry).href).catch(
    (e) => new LocalWhisperError({ reason: `failed to load runtime: ${String(e)}`, cause: e }),
  )
  if (transformers instanceof LocalWhisperError) return transformers

  const { pipeline, env } = transformers as {
    pipeline: (task: string, model: string, options?: object) => Promise<(audio: Float32Array, options?: object) => Promise<unknown>>
    env: { cacheDir: string }
  }
  env.cacheDir = modelsCacheDir()

  logger.log(`Loading local whisper model ${hfModel} (downloads on first use)...`)
  const seenFiles = new Set<string>()
  const asr = await pipeline('automatic-speech-recognition', hfModel, {
    dtype: 'q8',
    progress_callback: (progress: { status?: string; file?: string }) => {
      if (progress.status === 'download' && progress.file && !seenFiles.has(progress.file)) {
        seenFiles.add(progress.file)
        onProgress?.(`Downloading model file: ${progress.file}`)
      }
    },
  }).catch((e) => new LocalWhisperError({ reason: `failed to load model ${hfModel}: ${String(e)}`, cause: e }))
  if (asr instanceof Error) return asr

  cachedPipeline = { hfModel, asr }
  return asr
}

/**
 * Pre-download the model + verify the pipeline loads, so setup can report
 * "ready" before the first voice note arrives.
 */
export async function prepareLocalWhisperModel({
  modelId,
  onProgress,
}: {
  modelId: string
  onProgress?: (message: string) => void
}): Promise<LocalWhisperError | null> {
  const model = getLocalWhisperModelById(modelId)
  if (!model) return new LocalWhisperError({ reason: `unknown local model: ${modelId}` })

  const installed = await installLocalWhisperRuntime()
  if (installed instanceof Error) return installed

  const asr = await getPipeline({ hfModel: model.hfModel, onProgress })
  if (asr instanceof Error) return asr
  return null
}

/** Convert our 48 kHz mono 16-bit WAV (from prism decode) to 16 kHz Float32. */
function wav48kMonoToFloat32At16k(wav: Buffer): Float32Array {
  const pcm = wav.subarray(44)
  const sampleCount = Math.floor(pcm.length / 2)
  const out = new Float32Array(Math.floor(sampleCount / 3))
  for (let i = 0; i < out.length; i++) {
    const base = i * 6
    const a = pcm.readInt16LE(base)
    const b = pcm.readInt16LE(base + 2)
    const c = pcm.readInt16LE(base + 4)
    out[i] = (a + b + c) / (3 * 32768)
  }
  return out
}

// Mirrors the queue-detection behaviour the cloud transcription performs via
// its tool schema, using deterministic string matching instead of a model.
const QUEUE_PHRASES = [
  'queue this message',
  'queue this',
  'add this to the queue',
  'add to the queue',
  'queue it',
]

function detectQueueIntent(text: string): { transcription: string; queueMessage: boolean } {
  const lower = text.toLowerCase()
  for (const phrase of QUEUE_PHRASES) {
    const idx = lower.indexOf(phrase)
    if (idx === -1) continue
    const stripped = (text.slice(0, idx) + text.slice(idx + phrase.length))
      .replace(/^[\s.,;:!?-]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return { transcription: stripped.length > 0 ? stripped : text, queueMessage: true }
  }
  return { transcription: text, queueMessage: false }
}

/**
 * Transcribe a Discord voice note in-process with the configured local model.
 * Accepts OGG/Opus (native decode, no ffmpeg) and M4A (needs ffmpeg on PATH).
 */
export async function transcribeLocalWhisper({
  audio,
  mediaType,
  modelId,
}: {
  audio: Buffer
  mediaType: string
  modelId: string
}): Promise<LocalWhisperError | TranscriptionResult> {
  const model = getLocalWhisperModelById(modelId)
  if (!model) return new LocalWhisperError({ reason: `unknown local model: ${modelId}` })

  const normalized = normalizeAudioMediaType(mediaType || 'audio/ogg')
  const wav = await (async (): Promise<Error | Buffer> => {
    if (normalized === 'audio/ogg' || normalized === 'audio/opus') {
      return convertOggToWav(audio)
    }
    if (normalized === 'audio/mp4') {
      return convertM4aToWav(audio)
    }
    return new LocalWhisperError({
      reason: `unsupported audio type for local transcription: ${normalized}`,
    })
  })()
  if (wav instanceof Error) {
    return new LocalWhisperError({ reason: `audio decode failed: ${wav.message}`, cause: wav })
  }

  const float32 = wav48kMonoToFloat32At16k(wav)
  if (float32.length === 0) {
    return new LocalWhisperError({ reason: 'decoded audio is empty' })
  }

  const asr = await getPipeline({ hfModel: model.hfModel })
  if (asr instanceof Error) return asr

  const started = Date.now()
  // chunking handles voice notes longer than whisper's native 30s window
  const output = await asr(float32, { chunk_length_s: 30, stride_length_s: 5 }).catch(
    (e) => new LocalWhisperError({ reason: `inference failed: ${String(e)}`, cause: e }),
  )
  if (output instanceof LocalWhisperError) return output

  const text = (output as { text?: string })?.text?.trim() ?? ''
  logger.log(
    `Local whisper (${model.hfModel}) transcribed ${float32.length / 16000}s of audio in ${Date.now() - started}ms`,
  )
  if (!text) return { transcription: '[inaudible audio]', queueMessage: false }

  return { ...detectQueueIntent(text) }
}
