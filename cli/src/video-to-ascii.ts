import fs from 'node:fs'
import sharp from 'sharp'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'

// Force color output even in non-TTY environments
chalk.level = 3 // Full color support

const execAsync = promisify(exec)

const ASCII_CHARS = " .'-:!><+*#%&@"

export async function extractFrames({
  videoPath,
  outputDir,
  fps,
}: {
  videoPath: string
  outputDir: string
  fps: number
}) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  console.log(`Extracting frames at ${fps} fps...`)
  const command = `ffmpeg -i "${videoPath}" -vf fps=${fps} "${outputDir}/frame_%04d.png" -y`

  try {
    const { stdout, stderr } = await execAsync(command)
    console.log('Frames extracted successfully')
  } catch (error: any) {
    console.error('Error extracting frames:', error.message)
    throw error
  }
}

export async function convertImageToAscii({
  imagePath,
  cols,
  rows,
  keepAspectRatio = true,
  colored = false,
}: {
  imagePath: string
  cols: number
  rows: number
  keepAspectRatio?: boolean
  colored?: boolean
}) {
  try {
    const metadata = await sharp(imagePath).metadata()
    const originalWidth = metadata.width || 100
    const originalHeight = metadata.height || 100

    let finalCols = cols
    let finalRows = rows
    let resizeOptions: any = {}

    if (keepAspectRatio) {
      const aspectRatio = originalWidth / originalHeight
      const targetAspectRatio = (cols * 2) / rows

      if (aspectRatio > targetAspectRatio) {
        finalRows = Math.floor((cols / aspectRatio) * 0.5)
      } else {
        finalCols = Math.floor(rows * aspectRatio * 2)
      }
      resizeOptions = { fit: 'fill' }
    } else {
      const aspectRatio = originalWidth / originalHeight
      const targetAspectRatio = (cols * 2) / rows

      if (aspectRatio > targetAspectRatio) {
        const zoomHeight = Math.ceil((cols / aspectRatio) * 0.5)
        resizeOptions = {
          width: cols,
          height: zoomHeight,
          fit: 'cover',
          position: 'center',
        }
      } else {
        const zoomWidth = Math.ceil(rows * aspectRatio * 2)
        resizeOptions = {
          width: zoomWidth,
          height: rows,
          fit: 'cover',
          position: 'center',
        }
      }
      finalCols = cols
      finalRows = rows
    }

    if (colored) {
      // Get RGB data for colored output
      const { data, info } = await sharp(imagePath)
        .resize(finalCols, finalRows, resizeOptions)
        .raw()
        .toBuffer({ resolveWithObject: true })

      const asciiArt: string[] = []
      const channels = info.channels
      const actualCols = info.width
      const actualRows = info.height

      for (let y = 0; y < actualRows; y++) {
        let row = ''
        for (let x = 0; x < actualCols; x++) {
          const pixelIndex = (y * actualCols + x) * channels
          const r = data[pixelIndex] || 0
          const g = data[pixelIndex + 1] || 0
          const b = data[pixelIndex + 2] || 0

          // Calculate brightness from RGB
          const brightness = r * 0.299 + g * 0.587 + b * 0.114
          const charIndex = Math.floor(
            (brightness / 255) * (ASCII_CHARS.length - 1),
          )
          const char = ASCII_CHARS[charIndex] || ' '

          // Apply color using chalk
          row += chalk.rgb(r, g, b)(char)
        }

        // Pad row to requested width if needed (for colored output, count visible chars)
        if (!keepAspectRatio) {
          const visibleLength = stripAnsi(row).length
          if (visibleLength < cols) {
            row += ' '.repeat(cols - visibleLength)
          }
        }

        asciiArt.push(row)
      }

      // Pad to requested height if needed
      if (!keepAspectRatio) {
        while (asciiArt.length < rows) {
          asciiArt.push(' '.repeat(cols))
        }
      }

      return asciiArt.join('\n')
    } else {
      // Grayscale output (original implementation)
      const { data: resized, info } = await sharp(imagePath)
        .resize(finalCols, finalRows, resizeOptions)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true })

      // Use actual dimensions from the resized image
      const actualCols = info.width
      const actualRows = info.height

      const asciiArt: string[] = []

      for (let y = 0; y < actualRows; y++) {
        let row = ''
        for (let x = 0; x < actualCols; x++) {
          const pixelIndex = y * actualCols + x
          const brightness = resized[pixelIndex] || 0

          const charIndex = Math.floor(
            (brightness / 255) * (ASCII_CHARS.length - 1),
          )
          row += ASCII_CHARS[charIndex] || ' '
        }

        // Pad row to requested width if needed (for colored output, count visible chars)
        if (!keepAspectRatio) {
          const visibleLength = stripAnsi(row).length
          if (visibleLength < cols) {
            row += ' '.repeat(cols - visibleLength)
          }
        }

        asciiArt.push(row)
      }

      // Pad to requested height if needed
      if (!keepAspectRatio) {
        while (asciiArt.length < rows) {
          asciiArt.push(' '.repeat(cols))
        }
      }

      return asciiArt.join('\n')
    }
  } catch (error: any) {
    console.error(`Error converting ${imagePath}:`, error.message)
    throw error
  }
}
