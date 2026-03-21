// Resolve the .lintcn/ directory path relative to cwd.

import path from 'node:path'

export function getLintcnDir(): string {
  return path.resolve(process.cwd(), '.lintcn')
}
