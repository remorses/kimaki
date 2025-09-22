import os from 'node:os'
import JSONC from 'tiny-jsonc'
import fs from 'node:fs'
import path from 'node:path'

import { execSync } from 'node:child_process'

export async function getCurrentGitBranch(): Promise<string | undefined> {
  try {
    // First check if we're in a git repository
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' })
    } catch {
      return undefined
    }

    // Check if HEAD exists and has commits
    try {
      execSync('git rev-parse --verify HEAD', { stdio: 'ignore' })
    } catch {
      // No commits yet, check if we're on a branch
      try {
        const branch = execSync('git symbolic-ref --short HEAD', {
          encoding: 'utf-8',
        }).trim()
        return branch
      } catch {
        return undefined
      }
    }

    // Normal case: get current branch
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim()
    return branch === 'HEAD' ? undefined : branch
  } catch (e) {
    return undefined
  }
}

export function openUrlInBrowser(url: string) {
  let command: string

  switch (os.platform()) {
    case 'darwin':
      command = `open "${url}"`
      break
    case 'win32':
      command = `start "" "${url}"`
      break
    default:
      // linux, unix, etc.
      command = `xdg-open "${url}"`
      break
  }

  try {
    execSync(command, { stdio: 'ignore' })
  } catch (error) {
    console.error('Failed to open URL in browser:', error)
  }
}

export function safeParseJson<T = any>(str: string): T | undefined {
  try {
    return JSON.parse(str) as T
  } catch (e) {
    return undefined
  }
}

export function getGitRepoRoot(): string | undefined {
  try {
    const repoRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
    }).trim()
    return path.resolve(repoRoot)
  } catch {
    return undefined
  }
}

export function getGitRemoteUrl(): string | undefined {
  try {
    return execSync('git remote get-url origin', {
      encoding: 'utf-8',
    }).trim()
  } catch {
    return undefined
  }
}

export function getGitHubInfo():
  | { githubOwner: string; githubRepo: string; name: string }
  | undefined {
  const remoteUrl = getGitRemoteUrl()
  if (!remoteUrl) return undefined

  const match = remoteUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/)
  if (match) {
    return {
      githubOwner: match[1],
      githubRepo: match[2],
      name: match[2],
    }
  }
  return undefined
}

export function checkGitStatus(): {
  hasUncommittedChanges: boolean
  hasUnpushedCommits: boolean
  error?: string
} {
  try {
    // Check for uncommitted changes using porcelain format for machine readable output
    const gitStatus = execSync('git status --porcelain', {
      encoding: 'utf-8',
    }).trim()
    const hasUncommittedChanges = gitStatus.length > 0

    // Check for unpushed commits
    let hasUnpushedCommits = false
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf-8',
      }).trim()
      if (currentBranch && currentBranch !== 'HEAD') {
        // Check if remote branch exists
        try {
          execSync(`git rev-parse --verify origin/${currentBranch}`, {
            stdio: 'ignore',
          })
          // Remote branch exists, check for unpushed commits
          const unpushedCommits = execSync(
            `git log origin/${currentBranch}..${currentBranch} --oneline`,
            { encoding: 'utf-8' },
          ).trim()
          hasUnpushedCommits = unpushedCommits.length > 0
        } catch {
          // Remote branch doesn't exist, so we have unpushed commits
          hasUnpushedCommits = true
        }
      }
    } catch (e) {
      // Could not determine branch or remote status
      return {
        hasUncommittedChanges,
        hasUnpushedCommits: false,
        error: 'Could not check remote branch status',
      }
    }

    return { hasUncommittedChanges, hasUnpushedCommits }
  } catch (e) {
    return {
      hasUncommittedChanges: false,
      hasUnpushedCommits: false,
      error: e.message,
    }
  }
}
