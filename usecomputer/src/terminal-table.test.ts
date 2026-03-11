// Tests aligned terminal table formatting for deterministic CLI rendering.

import { describe, expect, test } from 'vitest'
import { renderAlignedTable } from './terminal-table.js'

describe('terminal table', () => {
  test('renders aligned columns for mixed widths', () => {
    const lines = renderAlignedTable({
      rows: [
        { id: 2, app: 'Zed', size: '1720x1440' },
        { id: 102, app: 'Google Chrome', size: '3440x1440' },
      ],
      columns: [
        {
          header: 'id',
          align: 'right',
          value: (row) => {
            return String(row.id)
          },
        },
        {
          header: 'app',
          value: (row) => {
            return row.app
          },
        },
        {
          header: 'size',
          align: 'right',
          value: (row) => {
            return row.size
          },
        },
      ],
    })

    expect(lines.join('\n')).toMatchInlineSnapshot(`
      " id  app                 size
      ---  -------------  ---------
        2  Zed            1720x1440
      102  Google Chrome  3440x1440"
    `)
  })
})
