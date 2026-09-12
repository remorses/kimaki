import type { GraphEdge, GraphNode, GraphTree } from './types.ts'

export const DEFAULT_NODE_SIZE = { width: 200, height: 120 }
export const GRID_CELL_SIZE = 40

export function flattenTree(tree: GraphTree, parentId: string | null = null): GraphNode[] {
  const width = tree.width ?? DEFAULT_NODE_SIZE.width
  const height = tree.height ?? DEFAULT_NODE_SIZE.height
  const node: GraphNode = {
    id: tree.id,
    content: tree.content,
    width,
    height,
    x: tree.x ?? 0,
    y: tree.y ?? 0,
    parentId,
  }
  const children = tree.children ?? []
  return [node, ...children.flatMap((child) => flattenTree(child, tree.id))]
}

export function edgesFromTree(tree: GraphTree): GraphEdge[] {
  const children = tree.children ?? []
  return [
    ...children.map((child) => ({ from: tree.id, to: child.id })),
    ...children.flatMap(edgesFromTree),
  ]
}

export function layoutHub({
  nodes,
  viewportWidth,
  viewportHeight,
}: {
  nodes: GraphNode[]
  viewportWidth: number
  viewportHeight: number
}): GraphNode[] {
  const root = nodes.find((node) => node.parentId === null)
  if (!root) return nodes

  const children = nodes.filter((node) => node.parentId === root.id)
  const others = nodes.filter((node) => node.id !== root.id && node.parentId !== root.id)
  const centerX = viewportWidth / 2
  const centerY = viewportHeight / 2
  const laidOutRoot: GraphNode = {
    ...root,
    x: root.x || centerX - root.width / 2,
    y: root.y || centerY - root.height / 2,
  }

  const radius = Math.max(180, Math.min(viewportWidth, viewportHeight) * 0.28)
  const laidOutChildren = children.map((child, index) => {
    if (child.x || child.y) return child
    const angle = -Math.PI / 2 + (index * (Math.PI * 2)) / Math.max(children.length, 1)
    return {
      ...child,
      x: centerX + Math.cos(angle) * radius - child.width / 2,
      y: centerY + Math.sin(angle) * radius - child.height / 2,
    }
  })

  return [laidOutRoot, ...laidOutChildren, ...others]
}

export function snapToGrid(value: number) {
  return Math.round(value / GRID_CELL_SIZE) * GRID_CELL_SIZE
}
