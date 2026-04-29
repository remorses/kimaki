#!/usr/bin/env tsx
/**
 * Sync skills from remote repos into the packaged cli/skills/ copy.
 *
 * Reimplements the core discovery logic from the `skills` npm CLI
 * (vercel-labs/skills) without depending on it. The flow is:
 *   1. Shallow-clone each source repo to ./tmp/
 *   2. Recursively walk for SKILL.md files, parse frontmatter
 *   3. Copy discovered skill directories into cli/skills/<name>/
 *   4. Clean up temp dirs
 *
 * Usage:  pnpm sync-skills          (from cli/ or root)
 *         tsx scripts/sync-skills.ts (from cli/)
 */

import fs from 'node:fs'
import path from 'node:path'
import { execAsync } from '../src/exec-async.js'

// ─── Config ──────────────────────────────────────────────────────────────────
// Each entry is a GitHub URL. Subpath after /tree/branch/ narrows the search.
const SKILL_SOURCES: string[] = [
  'https://github.com/remorses/playwriter',
  'https://github.com/remorses/tuistory',
  'https://github.com/remorses/zele',
  'https://github.com/remorses/critique',
  'https://github.com/remorses/errore',
  'https://github.com/remorses/egaki',
  'https://github.com/remorses/termcast',
  'https://github.com/remorses/goke',
  'https://github.com/remorses/spiceflow',
  'https://github.com/remorses/lintcn',
  'https://github.com/remorses/usecomputer',
  // 'https://github.com/remorses/gitchamber',
  'https://github.com/remorses/profano',
  'https://github.com/remorses/sigillo',
]

// Directories to skip during recursive SKILL.md search
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.next',
  '.turbo',
])

// ─── Types ───────────────────────────────────────────────────────────────────

interface SkillInfo {
  /** Skill name from frontmatter */
  name: string
  /** Skill description from frontmatter */
  description: string
  /** Absolute path to the skill directory (parent of SKILL.md) */
  dirPath: string
}

interface ParsedSource {
  /** Clone URL */
  url: string
  /** Optional git ref (branch/tag) */
  ref?: string
  /** Optional subpath inside the repo to narrow the search */
  subpath?: string
}

// ─── Source parsing ──────────────────────────────────────────────────────────

function parseSource(input: string): ParsedSource {
  // GitHub URL with /tree/branch/path
  const treeWithPath = input.match(
    /github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/,
  )
  if (treeWithPath) {
    const [, owner, repo, ref, subpath] = treeWithPath
    return {
      url: `https://github.com/${owner}/${repo}.git`,
      ref,
      subpath,
    }
  }

  // GitHub URL with /tree/branch
  const treeOnly = input.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)$/)
  if (treeOnly) {
    const [, owner, repo, ref] = treeOnly
    return { url: `https://github.com/${owner}/${repo}.git`, ref }
  }

  // GitHub URL: https://github.com/owner/repo
  const repoUrl = input.match(/github\.com\/([^/]+)\/([^/]+)/)
  if (repoUrl) {
    const [, owner, repo] = repoUrl
    const cleanRepo = repo!.replace(/\.git$/, '')
    return { url: `https://github.com/${owner}/${cleanRepo}.git` }
  }

  // GitHub shorthand: owner/repo
  const shorthand = input.match(/^([^/]+)\/([^/]+)$/)
  if (shorthand) {
    const [, owner, repo] = shorthand
    return { url: `https://github.com/${owner}/${repo}.git` }
  }

  // Fallback: treat as direct git URL
  return { url: input }
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────
// Minimal YAML frontmatter parser. Avoids gray-matter dependency.
// Only extracts `name` and `description` fields from the --- block.

function parseFrontmatter(content: string): {
  name: string
  description: string
} | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) {
    return null
  }

  const yaml = match[1]!
  const nameMatch = yaml.match(/^name:\s*(.+)$/m)
  const descMatch = yaml.match(/^description:\s*(.+)$/m)

  if (!nameMatch || !descMatch) {
    return null
  }

  // Strip surrounding quotes if present
  const strip = (s: string) => s.trim().replace(/^['"]|['"]$/g, '')

  return {
    name: strip(nameMatch[1]!),
    description: strip(descMatch[1]!),
  }
}

// ─── Skill discovery ─────────────────────────────────────────────────────────

async function discoverSkills(
  baseDir: string,
  subpath?: string,
): Promise<SkillInfo[]> {
  const searchDir = subpath ? path.join(baseDir, subpath) : baseDir
  const skills: SkillInfo[] = []
  const seenNames = new Set<string>()

  await walkForSkills(searchDir, skills, seenNames, 0, 5, baseDir)
  return skills
}

async function walkForSkills(
  dir: string,
  skills: SkillInfo[],
  seenNames: Set<string>,
  depth: number,
  maxDepth = 5,
  repoRoot?: string,
): Promise<void> {
  if (depth > maxDepth) {
    return
  }

  const skillMdPath = path.join(dir, 'SKILL.md')
  if (fs.existsSync(skillMdPath)) {
    const content = fs.readFileSync(skillMdPath, 'utf-8')
    const meta = parseFrontmatter(content)
    if (meta && !seenNames.has(meta.name)) {
      skills.push({
        name: meta.name,
        description: meta.description,
        dirPath: dir,
      })
      seenNames.add(meta.name)
    }
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  const subdirs = entries.filter((e) => {
    return e.isDirectory() && !SKIP_DIRS.has(e.name)
  })

  for (const sub of subdirs) {
    await walkForSkills(
      path.join(dir, sub.name),
      skills,
      seenNames,
      depth + 1,
      maxDepth,
      repoRoot,
    )
  }
}

// ─── Git clone ───────────────────────────────────────────────────────────────

async function cloneRepo(
  parsed: ParsedSource,
  tmpDir: string,
): Promise<string> {
  const targetDir = path.join(
    tmpDir,
    `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  const refArgs = parsed.ref ? `--branch ${parsed.ref}` : ''
  const cmd = `git clone --depth 1 ${refArgs} ${parsed.url} ${targetDir}`

  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await execAsync(cmd, { timeout: 60_000 })
      return targetDir
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error
      }

      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true })
      }

      const retryDelayMs = attempt * 1_000
      console.log(
        `    clone attempt ${attempt} failed, retrying in ${retryDelayMs}ms...`,
      )
      await new Promise((resolve) => {
        setTimeout(resolve, retryDelayMs)
      })
    }
  }

  return targetDir
}

// ─── Copy skill directory ────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, '-')
      .replace(/^[.\-]+|[.\-]+$/g, '') || 'unnamed-skill'
  )
}

async function copySkill(skill: SkillInfo, outputDir: string): Promise<string> {
  const dirName = sanitizeName(skill.name)
  const targetDir = path.join(outputDir, dirName)

  // Remove existing if present (idempotent)
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true })
  }

  // Only copy SKILL.md, never the full directory
  fs.mkdirSync(targetDir, { recursive: true })
  fs.copyFileSync(
    path.join(skill.dirPath, 'SKILL.md'),
    path.join(targetDir, 'SKILL.md'),
  )

  return targetDir
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname)
  const cliDir = path.resolve(scriptDir, '..')
  const repoRootDir = path.resolve(cliDir, '..')
  const cliSkillsDir = path.join(cliDir, 'skills')
  const tmpDir = path.join(repoRootDir, 'tmp')

  // Ensure output and tmp dirs exist
  fs.mkdirSync(cliSkillsDir, { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  console.log(`Syncing skills to ${cliSkillsDir}\n`)

  let totalSynced = 0

  for (const source of SKILL_SOURCES) {
    const parsed = parseSource(source)
    console.log(`\n--- ${source}`)
    console.log(
      `    clone: ${parsed.url}${parsed.ref ? ` @ ${parsed.ref}` : ''}`,
    )

    let cloneDir: string | undefined
    try {
      cloneDir = await cloneRepo(parsed, tmpDir)
      console.log(`    cloned to ${path.basename(cloneDir)}`)

      const skills = await discoverSkills(cloneDir, parsed.subpath)

      if (skills.length === 0) {
        console.log('    no skills found')
        continue
      }

      console.log(`    found ${skills.length} skill(s):`)

      for (const skill of skills) {
        const cliDest = await copySkill(skill, cliSkillsDir)
        console.log(
          `      - ${skill.name} -> ${path.relative(repoRootDir, cliDest)}`,
        )
        totalSynced++
      }
    } catch (err) {
      console.error(`    error: ${err instanceof Error ? err.message : err}`)
    } finally {
      // Clean up clone dir
      if (cloneDir && fs.existsSync(cloneDir)) {
        fs.rmSync(cloneDir, { recursive: true, force: true })
      }
    }
  }

  console.log(`\nDone. Synced ${totalSynced} skill(s).`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
