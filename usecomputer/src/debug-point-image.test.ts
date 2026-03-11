// Validates that debug-point image overlays draw a visible red marker.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { drawDebugPointOnImage } from './debug-point-image.js'

describe('drawDebugPointOnImage', () => {
  test('draws a red marker at the requested point', async () => {
    const sharpModule = await import('sharp')
    const sharp = sharpModule.default
    const filePath = path.join(process.cwd(), 'tmp', 'debug-point-image-test.png')

    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const baseImage = await sharp({
      create: {
        width: 40,
        height: 30,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer()
    fs.writeFileSync(filePath, baseImage)

    await drawDebugPointOnImage({
      imagePath: filePath,
      point: { x: 20, y: 15 },
      imageWidth: 40,
      imageHeight: 30,
    })

    const result = await sharp(filePath)
      .raw()
      .toBuffer({ resolveWithObject: true })
    const channels = result.info.channels
    const index = (15 * result.info.width + 20) * channels
    const pixel = Array.from(result.data.slice(index, index + channels))

    expect(pixel).toMatchInlineSnapshot(`
      [
        255,
        45,
        45,
        255,
      ]
    `)
  })
})
