// Maps Claude Agent SDK tool calls onto OpenCode's permission model.
//
// OpenCode gates tools with a PermissionRuleset: rules of
// { permission, pattern, action } evaluated with last-match-wins (findLast)
// semantics. Kimaki builds those rulesets at session.create time and renders
// permission.asked events as Discord buttons. The Claude backend replicates
// that flow: every canUseTool callback is translated into a permission
// descriptor here, evaluated against the session ruleset, and only escalated
// to Discord when the resolved action is "ask".

import path from 'node:path'
import type { PermissionRule, PermissionRuleset } from '@opencode-ai/sdk/v2'

export type PermissionDescriptor = {
  /** OpenCode permission name, e.g. "bash", "edit", "external_directory". */
  permission: string
  /** Patterns shown to the user and matched against the ruleset. */
  patterns: string[]
  /** Patterns persisted as allow rules when the user picks "Accept Always". */
  always: string[]
  metadata: Record<string, unknown>
}

/**
 * Wildcard matching with the same semantics as commands/permissions.ts —
 * `*` matches any run, `?` matches one char, and a trailing " *" also matches
 * the bare prefix (so "git *" matches "git").
 */
export function wildcardMatchValue({
  value,
  pattern,
}: {
  value: string
  pattern: string
}): boolean {
  let escapedPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')

  if (escapedPattern.endsWith(' .*')) {
    escapedPattern = escapedPattern.slice(0, -3) + '( .*)?'
  }

  return new RegExp(`^${escapedPattern}$`, 's').test(value)
}

/**
 * Default actions matching the opencode server config kimaki generates:
 * bash/edit/external_directory prompt by default, everything else runs.
 */
const DEFAULT_ACTIONS: Record<string, 'allow' | 'deny' | 'ask'> = {
  bash: 'ask',
  edit: 'ask',
  external_directory: 'ask',
  webfetch: 'allow',
  websearch: 'allow',
}

export function evaluatePermission({
  rules,
  permission,
  patterns,
}: {
  rules: PermissionRuleset
  permission: string
  patterns: string[]
}): 'allow' | 'deny' | 'ask' {
  // Every pattern must independently resolve to allow for the call to be
  // auto-allowed; any deny wins immediately; otherwise ask.
  let sawAsk = false
  for (const value of patterns) {
    const matched = findLastMatchingRule({ rules, permission, value })
    const action = matched?.action ?? DEFAULT_ACTIONS[permission] ?? 'allow'
    if (action === 'deny') {
      return 'deny'
    }
    if (action === 'ask') {
      sawAsk = true
    }
  }
  return sawAsk ? 'ask' : 'allow'
}

function findLastMatchingRule({
  rules,
  permission,
  value,
}: {
  rules: PermissionRuleset
  permission: string
  value: string
}): PermissionRule | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    if (!rule || rule.permission !== permission) {
      continue
    }
    if (wildcardMatchValue({ value, pattern: rule.pattern })) {
      return rule
    }
  }
  return undefined
}

function toWorkspacePattern({
  filePath,
  directory,
}: {
  filePath: string
  directory: string
}): string {
  const normalized = filePath.replaceAll('\\', '/')
  const normalizedDirectory = directory.replaceAll('\\', '/')
  if (!path.isAbsolute(normalized)) {
    return normalized
  }
  const relative = path.relative(normalizedDirectory, normalized).replaceAll('\\', '/')
  if (relative && !relative.startsWith('..')) {
    return relative
  }
  return normalized
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** First shell word of a bash command, used for "Accept Always" patterns. */
function bashAlwaysPattern(command: string): string {
  const trimmed = command.trim()
  const firstToken = trimmed.split(/\s+/)[0]
  if (!firstToken) {
    return trimmed || '*'
  }
  if (firstToken === trimmed) {
    return firstToken
  }
  return `${firstToken} *`
}

/**
 * Tools that never need a permission prompt from kimaki's point of view.
 * Read/Glob/Grep inside the workspace are safe; task orchestration, todo
 * bookkeeping, and kimaki's own MCP tools are side-effect free for the host.
 */
const AUTO_ALLOWED_TOOLS = new Set([
  'Task',
  'TodoWrite',
  'ExitPlanMode',
  'BashOutput',
  'KillShell',
  'KillBash',
  'Skill',
  'SlashCommand',
  'ListMcpResources',
  'ReadMcpResource',
  'NotebookRead',
  'LS',
])

/**
 * Translate a Claude tool call into an OpenCode permission descriptor.
 * Returns undefined when the call should be auto-allowed without consulting
 * the ruleset (safe read-only tools inside the workspace).
 */
export function describeToolPermission({
  toolName,
  input,
  directory,
  blockedPath,
}: {
  toolName: string
  input: Record<string, unknown>
  directory: string
  blockedPath?: string
}): PermissionDescriptor | undefined {
  // Paths outside the workspace surface as external_directory regardless of
  // which tool triggered them — mirrors opencode's external_directory gate.
  if (blockedPath) {
    const pattern = blockedPath.replaceAll('\\', '/')
    return {
      permission: 'external_directory',
      patterns: [pattern],
      always: [pattern, `${pattern}/*`],
      metadata: { tool: toolName, blockedPath },
    }
  }

  if (toolName === 'Bash') {
    const command = readString(input, 'command') ?? ''
    return {
      permission: 'bash',
      patterns: [command || '*'],
      always: [bashAlwaysPattern(command)],
      metadata: { tool: toolName, command },
    }
  }

  if (
    toolName === 'Edit' ||
    toolName === 'Write' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit'
  ) {
    const filePath = readString(input, 'file_path') ?? readString(input, 'notebook_path') ?? ''
    const pattern = filePath ? toWorkspacePattern({ filePath, directory }) : '*'
    return {
      permission: 'edit',
      patterns: [pattern],
      // Accept Always on an edit permission allows all future edits, which is
      // what opencode does for its edit gate as well.
      always: ['*'],
      metadata: { tool: toolName, filePath },
    }
  }

  if (toolName === 'WebFetch') {
    const url = readString(input, 'url') ?? '*'
    const always = (() => {
      const parsed = (() => {
        if (url === '*') return null
        return URL.canParse(url) ? new URL(url) : null
      })()
      if (!parsed) {
        return [url]
      }
      return [`${parsed.protocol}//${parsed.hostname}*`]
    })()
    return {
      permission: 'webfetch',
      patterns: [url],
      always,
      metadata: { tool: toolName, url },
    }
  }

  if (toolName === 'WebSearch') {
    const searchQuery = readString(input, 'query') ?? '*'
    return {
      permission: 'websearch',
      patterns: [searchQuery],
      always: ['*'],
      metadata: { tool: toolName, query: searchQuery },
    }
  }

  if (
    toolName === 'Read' ||
    toolName === 'Glob' ||
    toolName === 'Grep' ||
    AUTO_ALLOWED_TOOLS.has(toolName) ||
    toolName.startsWith('mcp__')
  ) {
    return undefined
  }

  // Unknown tool: surface it under its own name so deny/allow rules written
  // as `<tool>:action` still apply, defaulting to allow.
  return {
    permission: toolName.toLowerCase(),
    patterns: ['*'],
    always: ['*'],
    metadata: { tool: toolName },
  }
}

/** Rules appended to the session ruleset after an "Accept Always" reply. */
export function buildAlwaysRules({
  permission,
  always,
}: {
  permission: string
  always: string[]
}): PermissionRuleset {
  const patterns = always.length > 0 ? always : ['*']
  return patterns.map((pattern) => {
    return { permission, pattern, action: 'allow' as const }
  })
}
