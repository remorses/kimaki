import fs from 'node:fs'
import path from 'node:path'
import { extractFrames, convertImageToAscii } from '../src/video-to-ascii'

const FPS = 20
const ASCII_COLS = 160
const ASCII_ROWS = 50
const KEEP_ASPECT_RATIO = false

const videoPath =
  '/Users/morse/Documents/GitHub/kimakivoice/cli/assets/video.mp4'
const outputDir = path.join(path.dirname(videoPath), 'ascii')
const framesDir = path.join(path.dirname(videoPath), 'frames')

async function main() {
  try {
    await extractFrames({
      videoPath,
      outputDir: framesDir,
      fps: FPS,
    })

    const frameFiles = fs
      .readdirSync(framesDir)
      .filter((file) => file.endsWith('.png'))
      .sort()

    console.log(`Found ${frameFiles.length} frames to convert`)

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    for (let i = 0; i < frameFiles.length; i++) {
      const frameFile = frameFiles[i]
      const framePath = path.join(framesDir, frameFile)
      const frameNumber = frameFile.match(/frame_(\d+)\.png/)?.[1] || '0000'

      console.log(
        `Converting frame ${i + 1}/${frameFiles.length}: ${frameFile}`,
      )

      const asciiArt = await convertImageToAscii({
        imagePath: framePath,
        cols: ASCII_COLS,
        rows: ASCII_ROWS,
        keepAspectRatio: KEEP_ASPECT_RATIO,
      })

      const outputPath = path.join(outputDir, `frame_${frameNumber}.txt`)
      fs.writeFileSync(outputPath, asciiArt)
    }

    console.log(`\nConversion complete! ASCII frames saved to: ${outputDir}`)
    console.log(`Total frames converted: ${frameFiles.length}`)
    console.log(`Frame rate: ${FPS} fps`)
    console.log(`ASCII dimensions: ${ASCII_COLS}x${ASCII_ROWS}`)
    console.log(`Aspect ratio preserved: ${KEEP_ASPECT_RATIO}`)
  } catch (error: any) {
    console.error('Error in main process:', error.message)
    process.exit(1)
  }
}

main()
