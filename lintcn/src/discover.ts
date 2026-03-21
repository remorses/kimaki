// Scan .lintcn/*.go files for rule.Rule variables and lintcn: metadata comments.
// Returns structured info about each discovered rule for codegen and list display.

import fs from 'node:fs'
import path from 'node:path'

export interface RuleMetadata {
  /** kebab-case rule name from // lintcn:name or derived from filename */
  name: string
  /** one-line description from // lintcn:description */
  description: string
  /** original source URL from // lintcn:source */
  source: string
  /** exported Go variable name like NoFloatingPromisesRule */
  varName: string
  /** filename relative to .lintcn/ */
  fileName: string
}

const RULE_VAR_RE = /^var\s+(\w+)\s*=\s*rule\.Rule\s*\{/m
const METADATA_RE = /^\/\/\s*lintcn:(\w+)\s+(.+)$/gm

export function parseMetadata(content: string): Record<string, string> {
  const meta: Record<string, string> = {}
  for (const match of content.matchAll(METADATA_RE)) {
    meta[match[1]] = match[2].trim()
  }
  return meta
}

export function parseRuleVar(content: string): string | undefined {
  const match = content.match(RULE_VAR_RE)
  return match?.[1]
}

export function discoverRules(lintcnDir: string): RuleMetadata[] {
  if (!fs.existsSync(lintcnDir)) {
    return []
  }

  const files = fs.readdirSync(lintcnDir).filter((f) => {
    return f.endsWith('.go') && !f.endsWith('_test.go')
  })

  const rules: RuleMetadata[] = []

  for (const fileName of files) {
    const filePath = path.join(lintcnDir, fileName)
    const content = fs.readFileSync(filePath, 'utf-8')

    const varName = parseRuleVar(content)
    if (!varName) {
      continue
    }

    const meta = parseMetadata(content)
    const baseName = fileName.replace(/\.go$/, '')

    rules.push({
      name: meta.name || baseName.replace(/_/g, '-'),
      description: meta.description || '',
      source: meta.source || '',
      varName,
      fileName,
    })
  }

  return rules
}
