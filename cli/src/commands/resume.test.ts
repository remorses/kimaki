import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  getSessionDirectoryMismatchReply,
  isSessionInWorkingDirectory,
} from './resume.js'

describe('isSessionInWorkingDirectory', () => {
  test('accepts only the resolved current working directory', () => {
    const projectDirectory = path.resolve('tmp/resume-project')

    expect(isSessionInWorkingDirectory({
      sessionDirectory: projectDirectory,
      workingDirectory: projectDirectory,
    })).toBe(true)
    expect(isSessionInWorkingDirectory({
      sessionDirectory: path.join(projectDirectory, '..', 'other-project'),
      workingDirectory: projectDirectory,
    })).toBe(false)
    expect(isSessionInWorkingDirectory({
      sessionDirectory: path.join(projectDirectory, 'nested'),
      workingDirectory: projectDirectory,
    })).toBe(false)
  })

  test('returns a useful reply for a session from another directory', () => {
    expect(getSessionDirectoryMismatchReply({
      sessionDirectory: '/projects/other',
      workingDirectory: '/projects/current',
    })).toMatchInlineSnapshot(
      `"This session belongs to a different project or worktree: \`/projects/other\`. Run \`/resume\` in the channel for that directory."`,
    )
  })
})
