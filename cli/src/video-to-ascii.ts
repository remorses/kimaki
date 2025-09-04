import fs from 'node:fs'
import sharp from 'sharp'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

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
}: {
  imagePath: string
  cols: number
  rows: number
  keepAspectRatio?: boolean
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

    const resized = await sharp(imagePath)
      .resize(finalCols, finalRows, resizeOptions)
      .greyscale()
      .raw()
      .toBuffer()

    const asciiArt: string[] = []

    for (let y = 0; y < finalRows; y++) {
      let row = ''
      for (let x = 0; x < finalCols; x++) {
        const pixelIndex = y * finalCols + x
        const brightness = resized[pixelIndex]

        const charIndex = Math.floor(
          (brightness / 255) * (ASCII_CHARS.length - 1),
        )
        row += ASCII_CHARS[charIndex]
      }
      asciiArt.push(row)
    }

    return asciiArt.join('\n')
  } catch (error: any) {
    console.error(`Error converting ${imagePath}:`, error.message)
    throw error
  }
}
