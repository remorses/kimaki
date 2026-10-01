import { expect, test } from 'vitest'

import { editedPaths } from './session-events.ts'

test('editedPaths reads edit/write paths and every file header of a patch', () => {
  const patchText = '*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: b.txt\n*** Move to: c.txt\n*** Delete File: d.txt\n*** End Patch'
  expect({
    edit: editedPaths({ name: 'edit', input: { path: 'src/e.ts' } }),
    write: editedPaths({ name: 'write', input: { path: 'w.txt' } }),
    patch: editedPaths({ name: 'patch', input: { patchText } }),
    shell: editedPaths({ name: 'shell', input: { command: 'touch f' } }),
    missing: editedPaths({ name: 'edit', input: undefined }),
  }).toMatchInlineSnapshot(`
    {
      "edit": [
        "src/e.ts",
      ],
      "missing": [],
      "patch": [
        "a.txt",
        "b.txt",
        "d.txt",
        "c.txt",
      ],
      "shell": [],
      "write": [
        "w.txt",
      ],
    }
  `)
})
