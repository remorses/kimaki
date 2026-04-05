// Optimizes oversized images before they reach the LLM API.
// Prevents "image dimensions exceed max allowed" errors from Anthropic/Google/OpenAI.
// Hooks into tool.execute.after (read) and experimental.chat.messages.transform (clipboard paste).
// Uses sharp to resize images > 2000px and compress images > 4MB.
// Vendored from https://github.com/kargnas/opencode-large-image-optimizer, simplified to zero-config.

import type { Plugin } from '@opencode-ai/plugin'

// Conservative safe floor for Anthropic many-image requests (20+ images = 2000px limit).
// OpenCode resends history so image counts accumulate across turns — 2000px is safest.
const MAX_DIMENSION = 2000
// 4MB safe margin under Anthropic's 5MB limit
const MAX_FILE_SIZE = 4 * 1024 * 1024
const SUPPORTED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
])

// sharp is an optionalDependency — lazy-load to avoid breaking all plugins if missing
type SharpFn = (input?: Buffer | string) => import('sharp').Sharp

let sharpFactory: SharpFn | null | undefined

async function getSharp(): Promise<SharpFn | null> {
  if (sharpFactory !== undefined) {
    return sharpFactory
  }
  try {
    const mod = await import('sharp')
    // sharp uses `export =` so it lands on .default in ESM interop
    const fn = typeof mod === 'function' ? mod : (mod as { default: SharpFn }).default
    if (typeof fn === 'function') {
      sharpFactory = fn
    } else {
      sharpFactory = null
    }
  } catch {
    sharpFactory = null
  }
  return sharpFactory
}

function extractBase64Data(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/s)
  if (match?.[1]) {
    return match[1]
  }
  // raw base64 string (no data: prefix)
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) {
    return dataUrl
  }
  return null
}

interface OptimizeResult {
  dataUrl: string
  mime: string
}

async function optimizeImage(
  dataUrl: string,
  mime: string,
): Promise<OptimizeResult | null> {
  const sharp = await getSharp()
  if (!sharp) {
    return null
  }

  const rawBase64 = extractBase64Data(dataUrl)
  if (!rawBase64) {
    return null
  }

  const inputBuffer = Buffer.from(rawBase64, 'base64')
  if (inputBuffer.length === 0) {
    return null
  }

  const metadata = await sharp(inputBuffer).metadata()
  const width = metadata.width || 0
  const height = metadata.height || 0
  if (width === 0 || height === 0) {
    return null
  }

  const needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION
  const needsCompress = inputBuffer.length > MAX_FILE_SIZE
  if (!needsResize && !needsCompress) {
    return null
  }

  let pipeline = sharp(inputBuffer)
  let outputMime = mime

  if (needsResize) {
    pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
  }

  let outputBuffer = await pipeline.toBuffer()

  // if still over 4MB, convert to JPEG with progressive quality reduction
  if (outputBuffer.length > MAX_FILE_SIZE) {
    for (const quality of [100, 90, 80, 70]) {
      outputBuffer = await sharp(outputBuffer)
        .jpeg({ quality, mozjpeg: true })
        .toBuffer()
      outputMime = 'image/jpeg'
      if (outputBuffer.length <= MAX_FILE_SIZE) {
        break
      }
    }
  }

  return {
    dataUrl: `data:${outputMime};base64,${outputBuffer.toString('base64')}`,
    mime: outputMime,
  }
}

// runtime guard — tool.execute.after output type doesn't declare attachments
function hasAttachments(
  value: unknown,
): value is { attachments: Array<{ mime?: string; url?: string }> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'attachments' in value &&
    Array.isArray((value as { attachments?: unknown }).attachments)
  )
}

const imageOptimizerPlugin: Plugin = async () => {
  return {
    'tool.execute.after': async (input, output) => {
      const tool = input.tool.toLowerCase()

      // read tool: optimize image attachments
      if (tool === 'read' && hasAttachments(output)) {
        for (const att of output.attachments) {
          if (
            !att.mime ||
            !att.url ||
            !SUPPORTED_MIMES.has(att.mime.toLowerCase())
          ) {
            continue
          }
          const result = await optimizeImage(att.url, att.mime).catch(
            () => null,
          )
          if (result) {
            att.url = result.dataUrl
            att.mime = result.mime
          }
        }
      }

    },

    // clipboard paste: optimize file parts in message history
    'experimental.chat.messages.transform': async (_input, output) => {
      if (!output.messages || !Array.isArray(output.messages)) {
        return
      }
      for (const msg of output.messages) {
        if (!msg.parts || !Array.isArray(msg.parts)) {
          continue
        }
        for (const part of msg.parts) {
          if (part.type !== 'file') {
            continue
          }
          if (!SUPPORTED_MIMES.has(part.mime.toLowerCase())) {
            continue
          }
          const result = await optimizeImage(part.url, part.mime).catch(
            () => null,
          )
          if (result) {
            part.url = result.dataUrl
            part.mime = result.mime
          }
        }
      }
    },
  }
}

export { imageOptimizerPlugin }
