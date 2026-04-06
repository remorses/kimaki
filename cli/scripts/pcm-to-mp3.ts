#!/usr/bin/env bun
import { $ } from 'bun'
import path from 'node:path'
import fs from 'node:fs'

const logsDir = path.join(import.meta.dir, '../discord-audio-logs')

async function convertToMp3(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.mp3') {
    return
  }

  const dir = path.dirname(filePath)
  const basename = path.basename(filePath, ext)
  const outputPath = path.join(dir, `${basename}.mp3`)

  try {
    await fs.promises.access(outputPath, fs.constants.F_OK)
    console.log(`Skipping: ${outputPath} already exists`)
    return
  } catch {
    // file doesn't exist, continue with conversion
  }

  console.log(`Converting: ${filePath} -> ${outputPath}`)

  const inputFormat = ext.slice(1)

  const ffmpegArgs = ['-i', filePath, '-acodec', 'mp3', '-ac', '1']

  // Format is always s16le. Set sample rate by inspecting .16. or .24 in the file path/extension.
  if (inputFormat === 'pcm' || filePath.includes('.pcm')) {
    let sampleRate = '16000'
    if (filePath.includes('.24.')) {
      sampleRate = '24000'
    } else if (filePath.includes('.16.')) {
      sampleRate = '16000'
    }
    ffmpegArgs.unshift('-f', 's16le', '-ar', sampleRate, '-ac', '1')
  }

  ffmpegArgs.push(outputPath)

  try {
    await $`ffmpeg ${ffmpegArgs}`
    console.log(`✓ Converted: ${basename}${ext} -> ${basename}.mp3`)
  } catch (error) {
    console.error(`✗ Failed to convert ${filePath}:`, error)
  }
}

async function findAudioFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })

  const audioExtensions = [
    '.pcm',
    '.wav',
    '.flac',
    '.ogg',
    '.m4a',
    '.aac',
    '.wma',
    '.opus',
  ]

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      const subFiles = await findAudioFiles(fullPath)
      files.push(...subFiles)
    } else if (entry.isFile() && !entry.name.endsWith('.mp3')) {
      const ext = path.extname(entry.name).toLowerCase()
      const hasAudioExtension = audioExtensions.some((audioExt) =>
        entry.name.includes(audioExt),
      )

      if (hasAudioExtension || ext === '.pcm') {
        files.push(fullPath)
      }
    }
  }

  return files
}

async function main() {
  console.log(`Scanning for audio files in: ${logsDir}`)

  const audioFiles = await findAudioFiles(logsDir)

  if (audioFiles.length === 0) {
    console.log('No non-MP3 audio files found.')
    return
  }

  console.log(`Found ${audioFiles.length} files to convert:\n`)

  for (const file of audioFiles) {
    await convertToMp3(file)
  }

  console.log('\nConversion complete!')
}

main().catch(console.error)
