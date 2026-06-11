// Project emoji prefix map.
// Stores a user-defined emoji per project name so new channels and threads
// created for that project automatically start with the emoji as a prefix.
// The map is persisted at <dataDir>/project-emojis.json and keyed by the
// project folder basename (matches how channels are named).
//
// Corrupt or unreadable files are treated as an empty map so the bot never
// refuses to start because of a typo in this file.

import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'
import { getChannelDirectory } from './database.js'
import * as errore from 'errore'

const FILE_NAME = 'project-emojis.json'

class ProjectEmojisError extends errore.createTaggedError({
  name: 'ProjectEmojisError',
  message: 'Failed to load project emoji map: $reason',
}) {}

function emojiMapPath(): string {
  return path.join(getDataDir(), FILE_NAME)
}

function readEmojiMap(): Record<string, string> {
  const filePath = emojiMapPath()
  if (!fs.existsSync(filePath)) {
    return {}
  }
  const result = errore.try(() =>
    JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown,
  )
  if (result instanceof Error) {
    console.warn(
      `[project-emojis] ignoring unreadable ${FILE_NAME}: ${result.message}`,
    )
    return {}
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    console.warn(
      `[project-emojis] ignoring ${FILE_NAME}: expected an object mapping project name -> emoji`,
    )
    return {}
  }
  const validated: Record<string, string> = {}
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string' && value.length > 0 && key.length > 0) {
      validated[key] = value
    }
  }
  return validated
}

function writeEmojiMap(map: Record<string, string>): void {
  const filePath = emojiMapPath()
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(filePath, `${JSON.stringify(map, null, 2)}\n`, 'utf-8')
}

export function getProjectEmoji(
  projectDirectoryOrName: string,
): string | null {
  const name = path.basename(projectDirectoryOrName)
  const map = readEmojiMap()
  return map[name] ?? null
}

export function setProjectEmoji(projectName: string, emoji: string): void {
  const trimmed = projectName.trim()
  if (!trimmed) {
    throw new ProjectEmojisError({ reason: 'project name is empty' })
  }
  const map = readEmojiMap()
  map[trimmed] = emoji
  writeEmojiMap(map)
}

export function removeProjectEmoji(projectName: string): boolean {
  const map = readEmojiMap()
  if (!(projectName in map)) {
    return false
  }
  delete map[projectName]
  writeEmojiMap(map)
  return true
}

export function listProjectEmojis(): Record<string, string> {
  return readEmojiMap()
}

export function hasProjectEmojiPrefix(name: string, emoji: string): boolean {
  const trimmedName = name.trimStart()
  const trimmedEmoji = emoji.trim()
  if (!trimmedEmoji) {
    return true
  }
  return (
    trimmedName.startsWith(`${trimmedEmoji} `) ||
    trimmedName.startsWith(`${trimmedEmoji}-`) ||
    trimmedName === trimmedEmoji
  )
}

export function prefixNameWithEmoji(
  name: string,
  emoji: string | null,
): string {
  if (!emoji) {
    return name
  }
  if (hasProjectEmojiPrefix(name, emoji)) {
    return name
  }
  return `${emoji} ${name}`
}

export async function projectEmojiForChannel(
  channelId: string,
): Promise<string | null> {
  const config = await getChannelDirectory(channelId)
  if (!config) {
    return null
  }
  return getProjectEmoji(config.directory)
}
