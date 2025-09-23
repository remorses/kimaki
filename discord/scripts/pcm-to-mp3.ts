#!/usr/bin/env bun
import { $ } from "bun";
import path from "node:path";
import fs from "node:fs";

const logsDir = path.join(import.meta.dir, "../discord-audio-logs");

async function convertToMp3(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  
  if (ext === ".mp3") {
    return;
  }
  
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath, ext);
  const outputPath = path.join(dir, `${basename}.mp3`);
  
  console.log(`Converting: ${filePath} -> ${outputPath}`);
  
  const inputFormat = ext.slice(1);
  
  const ffmpegArgs = [
    "-i", filePath,
    "-acodec", "mp3",
    "-ac", "1"
  ];
  
  if (inputFormat === "pcm" || filePath.includes(".s16le.pcm")) {
    ffmpegArgs.unshift(
      "-f", "s16le",
      "-ar", "16000",
      "-ac", "1"
    );
  } else if (filePath.includes(".s24le")) {
    ffmpegArgs.unshift(
      "-f", "s24le",
      "-ar", "24000",
      "-ac", "1"
    );
  }
  
  ffmpegArgs.push(outputPath);
  
  try {
    await $`ffmpeg ${ffmpegArgs}`;
    console.log(`✓ Converted: ${basename}${ext} -> ${basename}.mp3`);
  } catch (error) {
    console.error(`✗ Failed to convert ${filePath}:`, error);
  }
}

async function findAudioFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  
  const audioExtensions = [".pcm", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".opus"];
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      const subFiles = await findAudioFiles(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile() && !entry.name.endsWith(".mp3")) {
      const ext = path.extname(entry.name).toLowerCase();
      const hasAudioExtension = audioExtensions.some(audioExt => entry.name.includes(audioExt));
      
      if (hasAudioExtension || ext === ".pcm") {
        files.push(fullPath);
      }
    }
  }
  
  return files;
}

async function main() {
  console.log(`Scanning for audio files in: ${logsDir}`);
  
  const audioFiles = await findAudioFiles(logsDir);
  
  if (audioFiles.length === 0) {
    console.log("No non-MP3 audio files found.");
    return;
  }
  
  console.log(`Found ${audioFiles.length} files to convert:\n`);
  
  for (const file of audioFiles) {
    await convertToMp3(file);
  }
  
  console.log("\nConversion complete!");
}

main().catch(console.error);