// Generic aligned terminal table renderer for CLI command output.

export type TableColumn<Row> = {
  header: string
  align?: 'left' | 'right'
  value: (row: Row) => string
}

export function renderAlignedTable<Row>({
  rows,
  columns,
}: {
  rows: Row[]
  columns: TableColumn<Row>[]
}): string[] {
  if (columns.length === 0) {
    return []
  }

  const widthByColumn = columns.map((column) => {
    const rowWidth = rows.reduce((maxWidth, row) => {
      const width = printableWidth(column.value(row))
      return Math.max(maxWidth, width)
    }, 0)
    return Math.max(printableWidth(column.header), rowWidth)
  })

  const formatCell = ({
    value,
    width,
    align,
  }: {
    value: string
    width: number
    align: 'left' | 'right'
  }): string => {
    const currentWidth = printableWidth(value)
    const padSize = Math.max(0, width - currentWidth)
    const padding = ' '.repeat(padSize)
    if (align === 'right') {
      return `${padding}${value}`
    }
    return `${value}${padding}`
  }

  const renderRow = ({
    values,
  }: {
    values: string[]
  }): string => {
    return values.map((value, index) => {
      const column = columns[index]
      if (!column) {
        return value
      }
      return formatCell({
        value,
        width: widthByColumn[index] ?? value.length,
        align: column.align ?? 'left',
      })
    }).join('  ')
  }

  const header = renderRow({
    values: columns.map((column) => {
      return column.header
    }),
  })

  const divider = widthByColumn.map((width) => {
    return '-'.repeat(width)
  }).join('  ')

  const lines = rows.map((row) => {
    return renderRow({
      values: columns.map((column) => {
        return column.value(row)
      }),
    })
  })

  return [header, divider, ...lines]
}

function printableWidth(value: string): number {
  const ansiStripped = value.replace(/\u001b\[[0-9;]*m/g, '')
  return ansiStripped.length
}
