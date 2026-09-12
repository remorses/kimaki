import type { ReactNode } from 'react'

export type GraphTree = {
  id: string
  content: ReactNode
  width?: number
  height?: number
  x?: number
  y?: number
  children?: GraphTree[]
}

export type GraphNode = {
  id: string
  content: ReactNode
  width: number
  height: number
  x: number
  y: number
  parentId: string | null
}

export type GraphEdge = {
  from: string
  to: string
}
