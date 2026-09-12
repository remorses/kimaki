import { describe, expect, test } from 'vitest'
import { edgesFromTree, flattenTree, layoutHub, snapToGrid } from './layout.ts'

const tree = {
  id: 'gateway',
  content: 'gateway',
  children: [
    { id: 'cli-a', content: 'a' },
    { id: 'cli-b', content: 'b' },
    { id: 'cli-c', content: 'c' },
  ],
}

describe('flattenTree', () => {
  test('keeps parent links', () => {
    const nodes = flattenTree(tree)
    expect(nodes.map((node) => `${node.id}:${node.parentId}`)).toMatchInlineSnapshot(`
      [
        "gateway:null",
        "cli-a:gateway",
        "cli-b:gateway",
        "cli-c:gateway",
      ]
    `)
  })
})

describe('edgesFromTree', () => {
  test('connects each child to the hub', () => {
    expect(edgesFromTree(tree)).toMatchInlineSnapshot(`
      [
        {
          "from": "gateway",
          "to": "cli-a",
        },
        {
          "from": "gateway",
          "to": "cli-b",
        },
        {
          "from": "gateway",
          "to": "cli-c",
        },
      ]
    `)
  })
})

describe('layoutHub', () => {
  test('places the hub in the viewport center', () => {
    const nodes = layoutHub({
      nodes: flattenTree(tree),
      viewportWidth: 1000,
      viewportHeight: 800,
    })
    const hub = nodes.find((node) => node.id === 'gateway')
    expect(hub?.x).toBe(400)
    expect(hub?.y).toBe(340)
    expect(nodes.filter((node) => node.parentId === 'gateway')).toHaveLength(3)
  })

  test('keeps explicit child coordinates', () => {
    const nodes = layoutHub({
      nodes: flattenTree({
        id: 'gateway',
        content: 'gateway',
        x: 10,
        y: 20,
        children: [{ id: 'cli-a', content: 'a', x: 80, y: 90 }],
      }),
      viewportWidth: 1000,
      viewportHeight: 800,
    })
    expect(nodes.map((node) => `${node.id}:${node.x},${node.y}`)).toMatchInlineSnapshot(`
      [
        "gateway:10,20",
        "cli-a:80,90",
      ]
    `)
  })
})

describe('edgesFromTree nested', () => {
  test('walks past the first child level', () => {
    expect(
      edgesFromTree({
        id: 'gateway',
        content: 'gateway',
        children: [
          {
            id: 'cli-a',
            content: 'a',
            children: [{ id: 'worker', content: 'w' }],
          },
        ],
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "from": "gateway",
          "to": "cli-a",
        },
        {
          "from": "cli-a",
          "to": "worker",
        },
      ]
    `)
  })
})

describe('snapToGrid', () => {
  test('rounds to 40px cells', () => {
    expect([snapToGrid(0), snapToGrid(19), snapToGrid(21), snapToGrid(80)]).toMatchInlineSnapshot(`
      [
        0,
        0,
        40,
        80,
      ]
    `)
  })
})
