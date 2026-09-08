import { expect, test } from 'vitest'
import { splitDiscordContent } from './discord-text.ts'

test('splitDiscordContent keeps short text whole', () => {
  expect(splitDiscordContent('ok')).toEqual(['ok'])
})

test('splitDiscordContent breaks long text at newlines', () => {
  const content = `${'a'.repeat(1900)}\n${'b'.repeat(200)}`
  const chunks = splitDiscordContent(content)
  expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true)
  expect(chunks.length).toBe(2)
  expect(chunks[0]).toBe('a'.repeat(1900))
  expect(chunks[1]).toBe('b'.repeat(200))
})
