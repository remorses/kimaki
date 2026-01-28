// Image processing utilities for Discord attachments.
// Uses sharp (optional) to resize large images and heic-convert (optional) for HEIC support.
// Falls back gracefully if dependencies are not available.

import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.FORMATTING)

const MAX_DIMENSION = 1500
const HEIC_MIME_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']

type SharpModule = typeof import('sharp')
type HeicConvertFn = (options: {
  buffer: ArrayBufferLike
  format: 'JPEG' | 'PNG'
  quality?: number
}) => Promise<ArrayBuffer>

let sharpModule: SharpModule | null | undefined = undefined
let heicConvertModule: HeicConvertFn | null | undefined = undefined

async function tryLoadSharp(): Promise<SharpModule | null> {
  if (sharpModule !== undefined) {
    return sharpModule
  }
  try {
    sharpModule = (await import('sharp')).default as unknown as SharpModule
    logger.log('sharp loaded successfully')
    return sharpModule
  } catch {
    logger.log('sharp not available, images will be sent at original size')
    sharpModule = null
    return null
  }
}

async function tryLoadHeicConvert(): Promise<HeicConvertFn | null> {
  if (heicConvertModule !== undefined) {
    return heicConvertModule
  }
  try {
    const mod = await import('heic-convert')
    heicConvertModule = mod.default as HeicConvertFn
    logger.log('heic-convert loaded successfully')
    return heicConvertModule
  } catch {
    logger.log('heic-convert not available, HEIC images will be sent as-is')
    heicConvertModule = null
    return null
  }
}

function isHeicMime(mime: string): boolean {
  return HEIC_MIME_TYPES.includes(mime.toLowerCase())
}

export async function processImage(
  buffer: Buffer,
  mime: string,
): Promise<{ buffer: Buffer; mime: string }> {
  // Skip non-images (PDFs, etc.)
  if (!mime.startsWith('image/')) {
    return { buffer, mime }
  }

  let workingBuffer = buffer
  let workingMime = mime

  // Handle HEIC conversion first (before sharp, since sharp doesn't support HEIC)
  if (isHeicMime(mime)) {
    const heicConvert = await tryLoadHeicConvert()
    if (heicConvert) {
      try {
        const outputArrayBuffer = await heicConvert({
          buffer: workingBuffer.buffer.slice(
            workingBuffer.byteOffset,
            workingBuffer.byteOffset + workingBuffer.byteLength,
          ),
          format: 'JPEG',
          quality: 0.85,
        })
        workingBuffer = Buffer.from(outputArrayBuffer)
        workingMime = 'image/jpeg'
        logger.log(`Converted HEIC to JPEG (${buffer.length} → ${workingBuffer.length} bytes)`)
      } catch (error) {
        logger.error('Failed to convert HEIC, sending original:', error)
        return { buffer, mime }
      }
    } else {
      // No heic-convert available, return original (LLM might not support it)
      logger.log('HEIC image detected but heic-convert not available, sending as-is')
      return { buffer, mime }
    }
  }

  // Now process with sharp (resize + ensure JPEG output)
  const sharp = await tryLoadSharp()
  if (!sharp) {
    return { buffer: workingBuffer, mime: workingMime }
  }

  try {
    const image = sharp(workingBuffer)
    const metadata = await image.metadata()
    const { width, height } = metadata

    const needsResize = width && height && (width > MAX_DIMENSION || height > MAX_DIMENSION)

    if (!needsResize) {
      // Still convert to JPEG for consistency (unless already JPEG from HEIC conversion)
      const outputBuffer = await image.jpeg({ quality: 85 }).toBuffer()
      logger.log(`Converted image to JPEG: ${width}x${height} (${outputBuffer.length} bytes)`)
      return { buffer: outputBuffer, mime: 'image/jpeg' }
    }

    // Resize and convert to JPEG
    const outputBuffer = await image
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer()

    logger.log(`Resized image: ${width}x${height} → max ${MAX_DIMENSION}px (${outputBuffer.length} bytes)`)

    return { buffer: outputBuffer, mime: 'image/jpeg' }
  } catch (error) {
    logger.error('Failed to process image with sharp, using working buffer:', error)
    return { buffer: workingBuffer, mime: workingMime }
  }
}
