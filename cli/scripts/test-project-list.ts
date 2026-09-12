#!/usr/bin/env tsx
import path from 'node:path'
import { OpenCode } from '@opencode/client'

async function testProjectList() {
  const port = process.env.OPENCODE_PORT || '3318'
  const baseUrl = `http://127.0.0.1:${port}`

  console.log(`Connecting to OpenCode server at ${baseUrl}...\n`)

  const client = OpenCode.make({ baseUrl })

  const projects = await client.project.list()

  console.log(`Total projects from OpenCode: ${projects.length}`)

  // Filter like add-project.ts does
  const testProjects = projects.filter((p) =>
    path.basename(p.canonical).startsWith('opencode-test-'),
  )
  console.log(`\nFiltered out (opencode-test-*): ${testProjects.length}`)

  const tempProjects = projects.filter(
    (p) => p.canonical.includes('/var/folders/') || p.canonical.includes('/tmp/'),
  )
  console.log(`Temp directories: ${tempProjects.length}`)

  const githubProjects = projects.filter((p) =>
    p.canonical.includes('/Documents/GitHub/'),
  )
  console.log(`GitHub projects: ${githubProjects.length}`)

  const worktreeProjects = projects.filter((p) =>
    p.canonical.includes('/.opencode/worktree/'),
  )
  console.log(`Worktree projects: ${worktreeProjects.length}`)

  // After filtering like add-project does
  const available = projects.filter(
    (p) => !path.basename(p.canonical).startsWith('opencode-test-'),
  )
  console.log(`\nAfter filtering test dirs: ${available.length}`)

  // Sort by time like add-project does
  const sorted = available.sort((a, b) => {
    const aTime = a.time.initialized || a.time.created
    const bTime = b.time.initialized || b.time.created
    return bTime - aTime
  })

  console.log(`\nTop 25 (what autocomplete shows):`)
  sorted.slice(0, 25).forEach((p, i) => {
    const time = p.time.initialized || p.time.created
    const date = new Date(time).toISOString().slice(0, 16).replace('T', ' ')
    console.log(
      `  ${i + 1}. ${date} | ${path.basename(p.canonical)} | ${p.canonical}`,
    )
  })

  process.exit(0)
}

testProjectList().catch((e) => {
  console.error('Error:', e)
  process.exit(1)
})
