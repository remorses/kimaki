// Pure auto-mode decision. No I/O. Skip, hard-deny, or classify.

import fs from 'node:fs'
import path from 'node:path'
import { analyzeBash } from './bash.ts'
import {
  hardDenyReason,
  hardDenyRedirect,
  hardDenyWritePath,
  pipelineHardDeny,
} from './hard-deny.ts'
import { isReadOnlyCommand } from './read-only.ts'

const SKIP_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'list',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'skill',
])

const WRITE_TOOLS = new Set(['edit', 'write', 'apply_patch'])

export type ToolCall = {
  tool: string
  args: Record<string, unknown>
  cwd: string
}

export type Decision =
  | { kind: 'skip' }
  | { kind: 'deny'; reason: string }
  | { kind: 'classify' }

function asString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function realpathOrResolve(filePath: string) {
  try {
    return fs.realpathSync.native(filePath)
  } catch {
    return path.resolve(filePath)
  }
}

function canonicalInsideCwd(filePath: string, cwd: string) {
  const root = realpathOrResolve(cwd)
  const resolved = path.resolve(cwd, filePath)
  const existing = (() => {
    try {
      return fs.realpathSync.native(resolved)
    } catch {
      let current = path.dirname(resolved)
      while (true) {
        try {
          return path.join(fs.realpathSync.native(current), path.relative(current, resolved))
        } catch {
          const parent = path.dirname(current)
          if (parent === current) return resolved
          current = parent
        }
      }
    }
  })()
  return existing === root || existing.startsWith(`${root}${path.sep}`)
}

export function decide(input: ToolCall): Decision {
  if (SKIP_TOOLS.has(input.tool)) return { kind: 'skip' }

  if (WRITE_TOOLS.has(input.tool)) {
    const filePath = asString(input.args.filePath) ?? asString(input.args.path)
    if (!filePath) return { kind: 'classify' }
    const denied = hardDenyWritePath(filePath, input.cwd)
    if (denied) return { kind: 'deny', reason: denied }
    if (canonicalInsideCwd(filePath, input.cwd)) return { kind: 'skip' }
    return { kind: 'classify' }
  }

  if (input.tool === 'bash' || input.tool === 'shell') {
    const command = asString(input.args.command)
    if (!command) return { kind: 'deny', reason: 'Missing bash command' }
    const analysis = analyzeBash(command)
    if (analysis.errors.length > 0) {
      return { kind: 'deny', reason: analysis.errors[0]! }
    }
    const pipelineDenied = pipelineHardDeny(analysis.pipelines)
    if (pipelineDenied) return { kind: 'deny', reason: pipelineDenied }
    for (const leaf of analysis.commands) {
      const denied = hardDenyReason(leaf)
      if (denied) return { kind: 'deny', reason: denied }
    }
    for (const redirect of analysis.redirects) {
      const denied = hardDenyRedirect(redirect, input.cwd)
      if (denied) return { kind: 'deny', reason: denied }
    }
    if (
      analysis.hasFileRedirect ||
      analysis.hasCommandSubstitution ||
      analysis.hasDynamicContent ||
      !analysis.structureSafe
    ) {
      return { kind: 'classify' }
    }
    if (analysis.commands.length === 0) return { kind: 'classify' }
    if (analysis.commands.every(isReadOnlyCommand)) return { kind: 'skip' }
    return { kind: 'classify' }
  }

  return { kind: 'classify' }
}
