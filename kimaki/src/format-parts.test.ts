// One snapshot per V2 tool shape, with visibility at both verbosities.

import { expect, test } from 'vitest'

import { formatToolFailed, formatToolLine, isToolVisible, type ToolCall } from './format-parts.ts'

const calls: ToolCall[] = [
  { name: 'shell', input: { command: 'pnpm test --run src/*.test.ts' } },
  { name: 'shell', input: { command: 'ls', description: 'list files', hasSideEffect: false } },
  { name: 'shell', input: { command: 'rm -rf dist', description: 'clean build output', hasSideEffect: true } },
  { name: 'edit', input: { path: '/repo/src/login.test.ts', oldString: 'a\nb\nc', newString: 'a\nB\nB2\nc' } },
  { name: 'write', input: { path: 'docs/notes_v2.md', content: 'one\ntwo\nthree' } },
  {
    name: 'patch',
    input: {
      patchText: '*** Begin Patch\n*** Add File: a.ts\n+one\n+two\n*** Update File: src/b.ts\n@@\n-old\n+new\n*** End Patch',
    },
  },
  { name: 'read', input: { path: 'README.md' } },
  { name: 'glob', input: { pattern: '**/*.ts' } },
  { name: 'grep', input: { pattern: 'TODO|FIXME' } },
  { name: 'subagent', input: { agent: 'explore', description: 'Find auth files', prompt: '...' } },
  { name: 'subagent', input: { agent: 'general', description: 'List repo folders', prompt: '...', background: true } },
  { name: 'webfetch', input: { url: 'https://kimaki.dev/docs', format: 'markdown' } },
  { name: 'question', input: { questions: [] } },
  { name: 'kimaki_sleep', input: { duration: '2h' } },
]

test('tool lines and visibility per verbosity', () => {
  expect(
    calls.map((call) => ({
      line: formatToolLine(call),
      tools: isToolVisible(call, 'tools'),
      text: isToolVisible(call, 'text'),
    })),
  ).toMatchInlineSnapshot(`
    [
      {
        "line": "-# ┣ shell _pnpm test --run src/\\*.test.ts_",
        "text": false,
        "tools": true,
      },
      {
        "line": "-# ┣ shell _list files_",
        "text": false,
        "tools": false,
      },
      {
        "line": "-# ┣ shell _clean build output_",
        "text": false,
        "tools": true,
      },
      {
        "line": "-# ◼︎ edit *login.test.ts* (+2-1)",
        "text": true,
        "tools": true,
      },
      {
        "line": "-# ◼︎ write *notes\\_v2.md* (3 lines)",
        "text": true,
        "tools": true,
      },
      {
        "line": "-# ◼︎ patch *a.ts* (+2-0), *b.ts* (+1-1)",
        "text": true,
        "tools": true,
      },
      {
        "line": "-# ┣ read _README.md_",
        "text": false,
        "tools": false,
      },
      {
        "line": "-# ┣ glob _\\*\\*/\\*.ts_",
        "text": false,
        "tools": false,
      },
      {
        "line": "-# ┣ grep _TODO\\|FIXME_",
        "text": false,
        "tools": false,
      },
      {
        "line": "-# ┣ explore **Find auth files**",
        "text": false,
        "tools": true,
      },
      {
        "line": "-# ┣ general **List repo folders** (background)",
        "text": false,
        "tools": true,
      },
      {
        "line": "-# ┣ webfetch _https://kimaki.dev/docs_",
        "text": false,
        "tools": true,
      },
      {
        "line": "-# ┣ question",
        "text": false,
        "tools": false,
      },
      {
        "line": "-# ┣ kimaki\\_sleep",
        "text": false,
        "tools": false,
      },
    ]
  `)
})

test('child tool lines carry the agent label, errors keep the first line', () => {
  expect([
    formatToolLine({ name: 'glob', input: { pattern: '*.md' } }, { label: 'general' }),
    formatToolLine({ name: 'edit', input: { path: 'a.ts', oldString: 'x', newString: 'y' } }, { label: 'general' }),
    formatToolFailed({ name: 'shell', message: 'Invalid arguments for tool "shell":\n- command: Missing key' }),
    formatToolFailed({ name: 'read', message: 'File not found: notes.md', label: 'explore' }),
  ]).toMatchInlineSnapshot(`
    [
      "-# ┣ general ⋅ glob _\\*.md_",
      "-# ◼︎ general ⋅ edit *a.ts* (+1-1)",
      "-# ⨯ shell _Invalid arguments for tool "shell":_",
      "-# ⨯ explore ⋅ read _File not found: notes.md_",
    ]
  `)
})
