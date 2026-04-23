// Unit tests for the orphan opencode sweep PID selection.
//
// Tests the pure parsing/selection helpers exported from hrana-server.ts so
// we can verify the logic without spawning real opencode servers or touching
// the OS process table.

import { describe, test, expect } from 'vitest'
import { parsePsOutput, selectOrphanOpencodePids } from './hrana-server.js'

describe('parsePsOutput', () => {
  test('parses typical ps -axo pid=,ppid=,command= output', () => {
    const output = [
      '  1234     1 /abs/path/opencode serve --port 12345 --print-logs',
      '  5678  1234 /abs/path/node cli.js',
      '    99     1 /usr/sbin/somed',
      '',
      ' 42000 42000 grep opencode',
    ].join('\n')

    const rows = parsePsOutput(output)

    expect(rows).toEqual([
      { pid: 1234, ppid: 1, command: '/abs/path/opencode serve --port 12345 --print-logs' },
      { pid: 5678, ppid: 1234, command: '/abs/path/node cli.js' },
      { pid: 99, ppid: 1, command: '/usr/sbin/somed' },
      { pid: 42000, ppid: 42000, command: 'grep opencode' },
    ])
  })
})

describe('selectOrphanOpencodePids', () => {
  test('picks orphaned opencode serve processes by basename', () => {
    const rows = [
      {
        pid: 100,
        ppid: 1,
        command: '/Users/t/.nvm/v24/bin/opencode serve --port 1111 --print-logs',
      },
      {
        pid: 101,
        ppid: 1,
        command: '/Users/t/.nvm/v24/bin/opencode serve --port 2222 --print-logs',
      },
    ]
    expect(selectOrphanOpencodePids({ rows, selfPid: 99 })).toEqual([100, 101])
  })

  test('matches the real-world orphan command shape (.opencode basename with long path)', () => {
    // This is the command line we observed on orphaned children in the wild:
    // a kimaki-spawned `opencode` wrapper dies, and the reparented orphan is
    // the actual `.opencode` binary under node_modules. Regression guard.
    const rows = [
      {
        pid: 90368,
        ppid: 1,
        command:
          '/Users/chubes/.nvm/versions/node/v24.13.1/lib/node_modules/opencode-ai/bin/.opencode serve --port 53817 --print-logs --log-level WARN',
      },
    ]
    expect(selectOrphanOpencodePids({ rows, selfPid: 99 })).toEqual([90368])
  })

  test('skips processes whose parent is not PID 1 (still healthy under a kimaki)', () => {
    const rows = [{ pid: 300, ppid: 12345, command: '/bin/opencode serve --port 5555' }]
    expect(selectOrphanOpencodePids({ rows, selfPid: 99 })).toEqual([])
  })

  test('skips unrelated opencode subcommands like tui or run', () => {
    const rows = [
      { pid: 400, ppid: 1, command: '/bin/opencode tui' },
      { pid: 401, ppid: 1, command: '/bin/opencode run some-task' },
      { pid: 402, ppid: 1, command: '/bin/opencode serverless --option' }, // starts with "serve" but isn't "serve"
    ]
    expect(selectOrphanOpencodePids({ rows, selfPid: 99 })).toEqual([])
  })

  test('skips non-opencode processes reparented to PID 1', () => {
    const rows = [
      { pid: 500, ppid: 1, command: '/usr/sbin/cupsd -l' },
      { pid: 501, ppid: 1, command: '/bin/serve-something --flag' },
      { pid: 502, ppid: 1, command: 'node serve.js' },
      // Especially: a `node` process running the opencode wrapper script —
      // argv[0] is `node`, not `opencode`, so we do NOT touch it. The real
      // .opencode child underneath would be matched separately on its own
      // line if it were orphaned.
      { pid: 503, ppid: 1, command: 'node /path/to/opencode serve --port 9999' },
    ]
    expect(selectOrphanOpencodePids({ rows, selfPid: 99 })).toEqual([])
  })
})
