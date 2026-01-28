// Image processing utilities for Discord attachments.
// Uses sharp (optional dependency) to resize large images before sending to opencode.
// Falls back gracefully if sharp is not available.

import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.FORMATTING)

const MAX_DIMENSION = 1500

type SharpModule = typeof import('sharp')
let sharpModule: SharpModule | null | undefined = undefined

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

export async function processImage(
  buffer: Buffer,
  mime: string,
): Promise<{ buffer: Buffer; mime: string }> {
  // Skip non-images (PDFs, etc.)
  if (!mime.startsWith('image/')) {
    return { buffer, mime }
  }

  const sharp = await tryLoadSharp()
  if (!sharp) {
    return { buffer, mime }
  }

  try {
    const image = sharp(buffer)
    const metadata = await image.metadata()
    const { width, height } = metadata

    const needsResize = width && height && (width > MAX_DIMENSION || height > MAX_DIMENSION)

    if (!needsResize) {
      // Still convert to JPEG for consistency
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
    logger.error('Failed to process image, using original:', error)
    return { buffer, mime }
  }
}
