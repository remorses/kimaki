import fs from 'node:fs'
import path from 'node:path'
import { createTwoFilesPatch, diffLines } from 'diff'

export const CACHE_REWRITES_DIR = 'cache-rewrites'

export function countSystemPromptDiffLines({
  beforeText,
  afterText,
}: {
  beforeText: string
  afterText: string
}): { additions: number; deletions: number } {
  const changes = diffLines(beforeText, afterText)
  let additions = 0
  let deletions = 0
  for (const change of changes) {
    if (change.added) additions += change.count ?? 0
    if (change.removed) deletions += change.count ?? 0
  }
  return { additions, deletions }
}

export function formatSystemPromptPatch({
  beforeText,
  afterText,
  sessionId,
  model,
  agent,
}: {
  beforeText: string
  afterText: string
  sessionId: string
  model?: string
  agent?: string
}): string {
  const { additions, deletions } = countSystemPromptDiffLines({ beforeText, afterText })
  const patch = createTwoFilesPatch(
    'system-before.txt',
    'system-after.txt',
    beforeText,
    afterText,
    undefined,
    undefined,
    { context: 3 },
  )
  return [
    `session: ${sessionId}`,
    `model: ${model ?? 'unknown'}`,
    `agent: ${agent ?? 'unknown'}`,
    `system +${additions} -${deletions}`,
    '',
    patch,
  ].join('\n')
}

export function cacheRewritePatchPath({
  dataDir,
  sessionId,
  now = Date.now(),
}: {
  dataDir: string
  sessionId: string
  now?: number
}): string {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(dataDir, CACHE_REWRITES_DIR, `${now}-${safeSessionId}.patch`)
}

export async function writeSystemPromptPatch({
  dataDir,
  sessionId,
  beforeText,
  afterText,
  model,
  agent,
  now,
}: {
  dataDir: string
  sessionId: string
  beforeText: string
  afterText: string
  model?: string
  agent?: string
  now?: number
}): Promise<string> {
  const filePath = cacheRewritePatchPath({ dataDir, sessionId, now })
  const dirPath = path.dirname(filePath)
  await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 })
  await fs.promises.writeFile(
    filePath,
    formatSystemPromptPatch({ beforeText, afterText, sessionId, model, agent }),
    { encoding: 'utf8', mode: 0o600 },
  )
  return filePath
}
