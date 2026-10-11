// Report how often the OpenCode `execute` (code mode) tool was used vs `shell`,
// what shell was used for (edits, reads, search...) and every execute example.
// Opens the OpenCode SQLite database read-only; it never writes to it.
//
//   node kimaki/scripts/tool-usage-report.ts [--days 3] [--db path] [--examples 15] > report.md

import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'

const { values: args } = parseArgs({
  options: {
    days: { type: 'string', default: '3' },
    db: { type: 'string', default: path.join(os.homedir(), '.local/share/opencode/opencode.db') },
    examples: { type: 'string', default: '15' },
  },
})
const days = Number(args.days)
const exampleLimit = Number(args.examples)
const since = Date.now() - days * 86_400_000

type ToolPart = {
  id: string
  name: string
  state: {
    status: string
    input?: Record<string, unknown>
    content?: Array<{ type: string; text?: string }>
    metadata?: { toolCalls?: Array<{ tool: string; status: string; input?: unknown }>; error?: boolean }
  }
}

type ToolRow = {
  sessionID: string
  title: string | null
  time: number
  model: string
  agent: string
  part: ToolPart
}

function log(message: string) {
  process.stderr.write(`${message}\n`)
}

function loadToolParts(): ToolRow[] {
  log(`opening ${args.db} read-only`)
  const db = new DatabaseSync(args.db, { readOnly: true })
  log(`querying tool parts since ${new Date(since).toISOString()}`)
  // json_each extracts only tool parts, so huge reasoning/text blobs never reach JS.
  const rows = db
    .prepare(
      `select m.session_id as sessionID, s.title as title, m.time_created as time,
              json_extract(m.data, '$.model.id') as model, json_extract(m.data, '$.agent') as agent,
              c.value as part
         from session_message m
         join json_each(m.data, '$.content') c
         left join session_v2 s on s.id = m.session_id
        where m.time_created > ? and m.type = 'assistant'
          and json_extract(c.value, '$.type') = 'tool'
        order by m.time_created`,
    )
    .all(since) as Array<Omit<ToolRow, 'part'> & { part: string }>
  db.close()
  // Forked sessions copy the parent history, so the same tool call id shows up again.
  const seen = new Set<string>()
  const unique = rows
    .map((row) => ({ ...row, model: row.model ?? '?', agent: row.agent ?? '?', part: JSON.parse(row.part) as ToolPart }))
    .filter((row) => !seen.has(row.part.id) && seen.add(row.part.id))
  log(`loaded ${rows.length} tool parts, ${unique.length} after removing fork copies`)
  return unique
}

// Shell command categories, in priority order: the first match is the primary use.
const shellCategories: Array<{ name: string; dedicatedTool?: string; test: (command: string) => boolean }> = [
  {
    name: 'edit files (sed -i, perl -i, python write, redirect, tee, patch)',
    dedicatedTool: 'edit/write',
    test: (c) =>
      /\bsed\s+(-[a-zA-Z]*\s+)*-i/.test(c) ||
      /\bperl\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i/.test(c) ||
      (firstWords(c).some((w) => /^(python3?|node|bun|uv)$/.test(w)) &&
        /\.write\(|write_text\(|writeFileSync|Bun\.write|open\([^)]*['"]w/.test(c)) ||
      /\btee\s+(-a\s+)?(?!\/dev\/)\S/.test(c) ||
      /\b(git apply|patch -p\d|apply_patch)\b/.test(c) ||
      redirectTargets(c).length > 0,
  },
  { name: 'file ops (mv, cp, rm, mkdir, touch, ln, chmod)', test: (c) => firstWords(c).some((w) => /^(mv|cp|rm|mkdir|touch|ln|chmod|rsync)$/.test(w)) },
  { name: 'git', test: (c) => firstWords(c).includes('git') },
  { name: 'gh', test: (c) => firstWords(c).includes('gh') },
  {
    name: 'own CLIs (kimaki, zele, sigillo, critique, lintcn, opensrc)',
    test: (c) => firstWords(c).some((w) => /^(kimaki|zele|sigillo|critique|lintcn|opensrc)$/.test(w)) || /\bcritique\b/.test(c),
  },
  {
    name: 'build / test / install',
    test: (c) => /\b(pnpm|npm|npx|bun|bunx|yarn|tsc|vitest|cargo|go|swift|xcodebuild|make|tsx|uv|uvx|pip)\b/.test(firstWords(c).join(' ')),
  },
  { name: 'search (grep, rg, find, ls, tree)', dedicatedTool: 'grep/glob', test: (c) => firstWords(c).some((w) => /^(grep|rg|ag|find|fd|ls|tree)$/.test(w)) },
  {
    name: 'read files (cat, head, tail, sed -n, wc, nl)',
    dedicatedTool: 'read',
    test: (c) => firstWords(c).some((w) => /^(cat|head|tail|less|wc|nl|jq)$/.test(w)) || /\bsed\s+-n\b/.test(c),
  },
  { name: 'network (curl, wget)', dedicatedTool: 'webfetch', test: (c) => firstWords(c).some((w) => /^(curl|wget|http)$/.test(w)) },
  { name: 'sqlite3', test: (c) => firstWords(c).includes('sqlite3') },
  { name: 'browser / devices (playwriter, ghosthand, tuistory, usecomputer)', test: (c) => /\b(playwriter|ghosthand|tuistory|usecomputer)\b/.test(c) },
  { name: 'scripts (python, node)', test: (c) => /\b(python3?|node)\b/.test(firstWords(c).join(' ')) },
  { name: 'other', test: () => true },
]

const shellKeywords = new Set(['do', 'then', 'else', 'time', 'sudo', '{', '('])

// First word of each list segment, skipping env assignments and `cd x &&`. Pipes are not
// split: in `git log | grep x` the grep only filters output, the command is git.
function firstWords(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n]/)
    .map((segment) => segment.trim().split(/\s+/).find((word) => word && !/^[A-Z_][A-Z0-9_]*=/.test(word) && !shellKeywords.has(word)) ?? '')
    .filter((word) => word && word !== 'cd')
}

// Output redirects to project files. Skips /dev/*, fd dups (2>&1), arrows inside quoted
// JS (`=>`), and scratch output in tmp folders.
function redirectTargets(command: string): string[] {
  const stripped = command
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, '<<HEREDOC')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  const targets = [...stripped.matchAll(/(?:^|[^0-9&<>=\-])>{1,2}\s*([^\s&|;)<>]+)/g)].map((m) => m[1])
  return targets.filter((target) => !/^(\/dev\/|&|''|""$)/.test(target) && !/(^|\/)(tmp|var\/folders)\//.test(target))
}

function categorize(command: string) {
  return shellCategories.find((category) => category.test(command))!
}

function countBy<T>(items: T[], key: (item: T) => string) {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function percent(part: number, total: number) {
  return total === 0 ? '0%' : `${((part / total) * 100).toFixed(1)}%`
}

function table(headers: string[], rows: Array<Array<string | number>>) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more chars)` : text
}

function fence(text: string, lang = '') {
  return `\`\`\`${lang}\n${text.replaceAll('```', '`\u200b``')}\n\`\`\``
}

const rows = loadToolParts()
const shells = rows.filter((row) => row.part.name === 'shell' || row.part.name === 'bash')
const executes = rows.filter((row) => row.part.name === 'execute')
const out: string[] = []

out.push(`# Tool usage, last ${days} days`, '')
out.push(`${rows.length} tool calls in ${new Set(rows.map((r) => r.sessionID)).size} sessions since ${new Date(since).toISOString()}.`, '')

out.push('## All tools', '')
out.push(table(['tool', 'calls', 'share'], countBy(rows, (r) => r.part.name).map(([name, n]) => [name, n, percent(n, rows.length)])), '')

out.push('## execute vs shell', '')
out.push(
  table(
    ['', 'shell', 'execute'],
    [
      ['calls', shells.length, executes.length],
      ['sessions using it', new Set(shells.map((r) => r.sessionID)).size, new Set(executes.map((r) => r.sessionID)).size],
      ['execute per 100 shell', '', ((executes.length / Math.max(shells.length, 1)) * 100).toFixed(2)],
    ],
  ),
  '',
)
const models = countBy([...shells, ...executes], (r) => `${r.model} (${r.agent})`)
out.push('### by model and agent', '')
out.push(
  table(
    ['model (agent)', 'shell', 'execute'],
    models.map(([key]) => [
      key,
      shells.filter((r) => `${r.model} (${r.agent})` === key).length,
      executes.filter((r) => `${r.model} (${r.agent})` === key).length,
    ]),
  ),
  '',
)

log('categorizing shell commands')
const categorized = shells.map((row) => {
  const command = String(row.part.state.input?.command ?? '')
  return { row, command, category: categorize(command) }
})
out.push('## What shell was used for', '')
out.push('Primary category per command, first match in priority order. Heuristic, based on the command text.', '')
out.push(
  table(
    ['category', 'calls', 'share', 'dedicated tool exists'],
    countBy(categorized, (c) => c.category.name).map(([name, n]) => [
      name,
      n,
      percent(n, shells.length),
      shellCategories.find((c) => c.name === name)?.dedicatedTool ?? '',
    ]),
  ),
  '',
)
const instead = categorized.filter((c) => c.category.dedicatedTool)
out.push(`**${instead.length}** shell calls (${percent(instead.length, shells.length)}) did something a dedicated tool also does.`, '')

const edits = categorized.filter((c) => c.category.dedicatedTool === 'edit/write')
out.push('### shell edit methods', '')
out.push(
  table(
    ['method', 'calls'],
    countBy(edits, ({ command }) => {
      if (/\bsed\s+(-[a-zA-Z]*\s+)*-i/.test(command)) return 'sed -i'
      if (/\bperl\b/.test(command)) return 'perl -i'
      if (/\bpython3?\b/.test(command)) return 'python script'
      if (/\b(node|bun)\b/.test(command)) return 'node/bun script'
      if (/\b(git apply|patch -p\d|apply_patch)\b/.test(command)) return 'patch'
      if (/\btee\b/.test(command)) return 'tee'
      return 'redirect (> file)'
    }),
  ),
  '',
)
out.push('### shell edit examples by model', '')
out.push(table(['model', 'shell edits', 'edit tool', 'write tool'], countBy(edits, (c) => c.row.model).map(([model, n]) => [
  model,
  n,
  rows.filter((r) => r.model === model && (r.part.name === 'edit' || r.part.name === 'patch')).length,
  rows.filter((r) => r.model === model && r.part.name === 'write').length,
])), '')
for (const { row, command } of edits.slice(-exampleLimit)) {
  out.push(`- ${row.model} in "${row.title ?? row.sessionID}" (${row.sessionID})`, '', fence(truncate(command, 600), 'sh'), '')
}

out.push('## execute (code mode) examples', '')
out.push(table(['inner tool', 'calls'], countBy(executes.flatMap((r) => r.part.state.metadata?.toolCalls ?? []), (c) => `${c.tool} (${c.status})`)), '')
for (const [i, row] of executes.entries()) {
  const part = row.part
  const input = part.state.input ?? {}
  const result = (part.state.content ?? []).map((c) => c.text ?? `[${c.type}]`).join('\n')
  const calls = (part.state.metadata?.toolCalls ?? []).map((c) => `${c.tool}:${c.status}`).join(', ') || 'none'
  out.push(`### ${i + 1}. ${String(input.description ?? '(no description)')}`, '')
  out.push(`- session: "${row.title ?? ''}" ${row.sessionID}`)
  out.push(`- time: ${new Date(row.time).toISOString()}, model: ${row.model}, agent: ${row.agent}`)
  out.push(`- status: ${part.state.status}${part.state.metadata?.error ? ' (error)' : ''}, inner calls: ${calls}`, '')
  out.push(fence(String(input.code ?? ''), 'js'), '', 'result:', '', fence(truncate(result, 800)), '')
}

process.stdout.write(`${out.join('\n')}\n`)
log('done')
