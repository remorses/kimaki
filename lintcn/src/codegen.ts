// Generate Go workspace files for building a custom tsgolint binary.
// Creates:
//   .lintcn/go.work       — workspace for gopls (editor support)
//   .lintcn/go.mod        — module declaration
//   build/go.work          — build workspace in cache dir
//   build/wrapper/go.mod   — wrapper module
//   build/wrapper/main.go  — tsgolint main.go with custom rules appended

import fs from 'node:fs'
import path from 'node:path'
import type { RuleMetadata } from './discover.ts'

// All replace directives needed from tsgolint's go.mod.
// These redirect shim module paths to local directories inside the tsgolint source.
const SHIM_MODULES = [
  'ast',
  'bundled',
  'checker',
  'compiler',
  'core',
  'lsp/lsproto',
  'parser',
  'project',
  'scanner',
  'tsoptions',
  'tspath',
  'vfs',
  'vfs/cachedvfs',
  'vfs/osvfs',
] as const

function generateReplaceDirectives(tsgolintRelPath: string): string {
  return SHIM_MODULES.map((mod) => {
    return `\tgithub.com/microsoft/typescript-go/shim/${mod} => ${tsgolintRelPath}/shim/${mod}`
  }).join('\n')
}

/** Generate .lintcn/go.work and .lintcn/go.mod for editor/gopls support.
 *
 *  Key learnings from testing:
 *  - Module name MUST be a child path of github.com/typescript-eslint/tsgolint
 *    so Go allows importing internal/ packages across the module boundary.
 *  - go.work must `use` both .tsgolint AND .tsgolint/typescript-go since
 *    tsgolint's own go.work (which does this) is ignored by the outer workspace.
 *  - go.mod should be minimal (no requires) — the workspace resolves everything. */
export function generateEditorGoFiles(lintcnDir: string): void {
  const goWork = `go 1.26

use (
\t.
\t./.tsgolint
\t./.tsgolint/typescript-go
)

replace (
${generateReplaceDirectives('./.tsgolint')}
)
`

  const goMod = `module github.com/typescript-eslint/tsgolint/lintcn-rules

go 1.26
`

  const gitignore = `.tsgolint/
go.work
go.work.sum
go.mod
go.sum
`

  fs.writeFileSync(path.join(lintcnDir, 'go.work'), goWork)
  fs.writeFileSync(path.join(lintcnDir, 'go.mod'), goMod)

  const gitignorePath = path.join(lintcnDir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, gitignore)
  }
}

/** Generate build workspace in cache dir for compiling the custom binary.
 *  Instead of hardcoding the built-in rule list, we copy tsgolint's actual
 *  main.go and inject custom rule imports + entries. This way the generated
 *  code always matches the pinned tsgolint version. */
export function generateBuildWorkspace({
  buildDir,
  tsgolintDir,
  lintcnDir,
  rules,
}: {
  buildDir: string
  tsgolintDir: string
  lintcnDir: string
  rules: RuleMetadata[]
}): void {
  fs.mkdirSync(path.join(buildDir, 'wrapper'), { recursive: true })

  // symlink tsgolint source
  const tsgolintLink = path.join(buildDir, 'tsgolint')
  if (fs.existsSync(tsgolintLink)) {
    fs.rmSync(tsgolintLink, { recursive: true })
  }
  fs.symlinkSync(tsgolintDir, tsgolintLink)

  // symlink user rules
  const rulesLink = path.join(buildDir, 'rules')
  if (fs.existsSync(rulesLink)) {
    fs.rmSync(rulesLink, { recursive: true })
  }
  fs.symlinkSync(path.resolve(lintcnDir), rulesLink)

  // go.work — must include typescript-go submodule and use child module paths
  const goWork = `go 1.26

use (
\t./tsgolint
\t./tsgolint/typescript-go
\t./wrapper
\t./rules
)

replace (
${generateReplaceDirectives('./tsgolint')}
)
`
  fs.writeFileSync(path.join(buildDir, 'go.work'), goWork)

  // wrapper/go.mod — must be child path of tsgolint for internal/ access.
  // Minimal: no require block. The workspace resolves all dependencies.
  // Adding explicit requires with v0.0.0 triggers Go proxy lookups that fail.
  const wrapperGoMod = `module github.com/typescript-eslint/tsgolint/lintcn-wrapper

go 1.26
`
  fs.writeFileSync(path.join(buildDir, 'wrapper', 'go.mod'), wrapperGoMod)

  // copy all supporting .go files from cmd/tsgolint/ (headless, payload, etc.)
  const wrapperDir = path.join(buildDir, 'wrapper')
  copyTsgolintCmdFiles(tsgolintDir, wrapperDir)

  // wrapper/main.go — copy from tsgolint and inject custom rules
  const mainGo = generateMainGoFromSource(tsgolintDir, rules)
  fs.writeFileSync(path.join(wrapperDir, 'main.go'), mainGo)
}

/** Copy all .go files from tsgolint's cmd/tsgolint/ into the wrapper dir,
 *  then inject custom rule imports + entries into main.go.
 *  This is version-safe: no hardcoded rule list, adapts to any tsgolint version. */
function generateMainGoFromSource(tsgolintDir: string, customRules: RuleMetadata[]): string {
  const mainGoPath = path.join(tsgolintDir, 'cmd', 'tsgolint', 'main.go')
  let mainGo = fs.readFileSync(mainGoPath, 'utf-8')

  if (customRules.length === 0) {
    return mainGo
  }

  const lintcnImport = `\tlintcn "github.com/typescript-eslint/tsgolint/lintcn-rules"`

  // Find the last line that imports from internal/rules/ and insert after it.
  // The import block has rule imports, then a blank line, then shim imports.
  const lines = mainGo.split('\n')
  let lastRuleImportIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('/internal/rules/')) {
      lastRuleImportIndex = i
    }
  }
  if (lastRuleImportIndex === -1) {
    throw new Error(
      'Failed to inject lintcn import: no /internal/rules/ import found in tsgolint main.go. ' +
      'The tsgolint source layout may have changed.',
    )
  }
  lines.splice(lastRuleImportIndex + 1, 0, lintcnImport)
  mainGo = lines.join('\n')

  // Add custom rule entries to allRules slice.
  const customEntries = customRules.map((r) => {
    return `\tlintcn.${r.varName},`
  }).join('\n')

  // Find last "pkg.XxxRule," entry before "}\n...var allRulesByName"
  const prevMainGo = mainGo
  mainGo = mainGo.replace(
    /(\w+\.\w+Rule,\s*\n)(}\s*\n\s*var allRulesByName)/,
    `$1${customEntries}\n$2`,
  )

  if (mainGo === prevMainGo) {
    throw new Error(
      'Failed to inject custom rules into allRules slice: pattern not found in tsgolint main.go. ' +
      'The tsgolint source layout may have changed.',
    )
  }

  // final assertion: verify our injections are present
  if (!mainGo.includes(`lintcn.${customRules[0].varName}`)) {
    throw new Error('Custom rule injection verification failed.')
  }

  return mainGo
}

/** Copy all supporting .go files from cmd/tsgolint/ into the wrapper dir.
 *  main.go is generated separately with custom rules injected. */
export function copyTsgolintCmdFiles(tsgolintDir: string, wrapperDir: string): void {
  const cmdDir = path.join(tsgolintDir, 'cmd', 'tsgolint')
  const files = fs.readdirSync(cmdDir).filter((f) => {
    return f.endsWith('.go') && f !== 'main.go' && !f.endsWith('_test.go')
  })
  for (const file of files) {
    fs.copyFileSync(path.join(cmdDir, file), path.join(wrapperDir, file))
  }
}
