import { expect, test } from 'vitest'
import { extractBtwSuffix } from './btw-suffix.ts'

test('punctuation and newline btw suffixes', () => {
  expect(extractBtwSuffix('fix the bug. btw')).toEqual({
    prompt: 'fix the bug',
    forceBtw: true,
  })
  expect(extractBtwSuffix('hello btw')).toEqual({
    prompt: 'hello btw',
    forceBtw: false,
  })
})
