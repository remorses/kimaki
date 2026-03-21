// lintcn add <url> — fetch a .go rule file by URL and copy into .lintcn/
// Also tries to fetch matching _test.go file from the same directory.
// Normalizes GitHub blob URLs to raw URLs automatically.

import fs from 'node:fs'
import path from 'node:path'
import { getLintcnDir } from '../paths.ts'
import { generateEditorGoFiles } from '../codegen.ts'
import { ensureTsgolintSource, DEFAULT_TSGOLINT_VERSION } from '../cache.ts'

function normalizeGithubUrl(url: string): string {
  // Convert github.com/user/repo/blob/branch/path to raw.githubusercontent.com
  const blobMatch = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/,
  )
  if (blobMatch) {
    const [, owner, repo, branch, filePath] = blobMatch
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`
  }
  return url
}

function deriveTestUrl(rawUrl: string): string {
  return rawUrl.replace(/\.go$/, '_test.go')
}

async function fetchFile(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      return null
    }
    return await response.text()
  } catch {
    return null
  }
}

function rewritePackageName(content: string): string {
  // Rewrite first package declaration to package lintcn
  return content.replace(/^package\s+\w+/m, 'package lintcn')
}

function ensureSourceComment(content: string, sourceUrl: string): string {
  if (content.includes('// lintcn:source')) {
    return content
  }
  // Insert source comment after the first lintcn: comment block, or at the very top
  const lines = content.split('\n')
  let insertIndex = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('// lintcn:')) {
      insertIndex = i + 1
    } else if (insertIndex > 0) {
      break
    }
  }
  lines.splice(insertIndex, 0, `// lintcn:source ${sourceUrl}`)
  return lines.join('\n')
}

export async function addRule(url: string): Promise<void> {
  const rawUrl = normalizeGithubUrl(url)

  console.log(`Fetching ${rawUrl}...`)
  const content = await fetchFile(rawUrl)
  if (!content) {
    throw new Error(`Could not fetch rule from ${rawUrl}`)
  }

  // validate it looks like a Go file with a rule
  if (!content.includes('rule.Rule')) {
    console.warn('Warning: no rule.Rule reference found in this file. Are you sure this is a tsgolint rule?')
  }

  // derive filename from URL
  const urlPath = new URL(rawUrl).pathname
  const fileName = path.basename(urlPath)
  if (!fileName.endsWith('.go')) {
    throw new Error(`URL must point to a .go file, got: ${fileName}`)
  }

  const lintcnDir = getLintcnDir()
  fs.mkdirSync(lintcnDir, { recursive: true })

  // write the rule file
  const filePath = path.join(lintcnDir, fileName)
  if (fs.existsSync(filePath)) {
    console.log(`Overwriting existing ${fileName}`)
  }

  let processed = rewritePackageName(content)
  processed = ensureSourceComment(processed, url)
  fs.writeFileSync(filePath, processed)
  console.log(`Added ${fileName}`)

  // try to fetch matching test file
  const testUrl = deriveTestUrl(rawUrl)
  const testContent = await fetchFile(testUrl)
  if (testContent) {
    const testFileName = fileName.replace(/\.go$/, '_test.go')
    const testProcessed = rewritePackageName(testContent)
    fs.writeFileSync(path.join(lintcnDir, testFileName), testProcessed)
    console.log(`Added ${testFileName}`)
  }

  // ensure .tsgolint source is available and generate editor support files
  const tsgolintDir = await ensureTsgolintSource(DEFAULT_TSGOLINT_VERSION)

  // create .tsgolint symlink inside .lintcn for gopls
  const tsgolintLink = path.join(lintcnDir, '.tsgolint')
  if (!fs.existsSync(tsgolintLink)) {
    fs.symlinkSync(tsgolintDir, tsgolintLink)
  }

  generateEditorGoFiles(lintcnDir)
  console.log('Editor support files generated (go.work, go.mod)')
}
