// Draws visible debug markers onto screenshots to validate coord-map targeting.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Point } from './types.js'

type SharpModule = typeof import('sharp')
const require = createRequire(import.meta.url)

async function loadSharp(): Promise<SharpModule> {
  try {
    return require('sharp') as SharpModule
  } catch (error) {
    throw new Error('Optional dependency `sharp` is required for `debug-point`. Install it with `pnpm add sharp --save-optional`.', {
      cause: error,
    })
  }
}

function createMarkerSvg({
  point,
  imageWidth,
  imageHeight,
}: {
  point: Point
  imageWidth: number
  imageHeight: number
}): string {
  const radius = 10
  const crosshairRadius = 22
  const ringRadius = 18

  return [
    `<svg width="${String(imageWidth)}" height="${String(imageHeight)}" xmlns="http://www.w3.org/2000/svg">`,
    '  <g>',
    `    <circle cx="${String(point.x)}" cy="${String(point.y)}" r="${String(ringRadius)}" fill="none" stroke="white" stroke-width="4" opacity="0.95" />`,
    `    <line x1="${String(point.x - crosshairRadius)}" y1="${String(point.y)}" x2="${String(point.x + crosshairRadius)}" y2="${String(point.y)}" stroke="white" stroke-width="5" stroke-linecap="round" opacity="0.95" />`,
    `    <line x1="${String(point.x)}" y1="${String(point.y - crosshairRadius)}" x2="${String(point.x)}" y2="${String(point.y + crosshairRadius)}" stroke="white" stroke-width="5" stroke-linecap="round" opacity="0.95" />`,
    `    <circle cx="${String(point.x)}" cy="${String(point.y)}" r="${String(ringRadius)}" fill="none" stroke="#ff2d2d" stroke-width="2" />`,
    `    <line x1="${String(point.x - crosshairRadius)}" y1="${String(point.y)}" x2="${String(point.x + crosshairRadius)}" y2="${String(point.y)}" stroke="#ff2d2d" stroke-width="3" stroke-linecap="round" />`,
    `    <line x1="${String(point.x)}" y1="${String(point.y - crosshairRadius)}" x2="${String(point.x)}" y2="${String(point.y + crosshairRadius)}" stroke="#ff2d2d" stroke-width="3" stroke-linecap="round" />`,
    `    <circle cx="${String(point.x)}" cy="${String(point.y)}" r="${String(radius)}" fill="#ff2d2d" stroke="white" stroke-width="3" />`,
    '  </g>',
    '</svg>',
  ].join('\n')
}

export async function drawDebugPointOnImage({
  imagePath,
  point,
  imageWidth,
  imageHeight,
}: {
  imagePath: string
  point: Point
  imageWidth: number
  imageHeight: number
}): Promise<void> {
  const sharpModule = await loadSharp()
  const markerSvg = createMarkerSvg({ point, imageWidth, imageHeight })
  const output = await sharpModule(imagePath)
    .composite([{ input: Buffer.from(markerSvg) }])
    .png()
    .toBuffer()

  fs.mkdirSync(path.dirname(imagePath), { recursive: true })
  fs.writeFileSync(imagePath, output)
}
