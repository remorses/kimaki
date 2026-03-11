// Parser helpers for CLI values such as coordinates, regions, and key modifiers.

import type { Point, Region, ScrollDirection } from './types.js'

export function parsePoint(input: string): Error | Point {
  const parts = input.split(',').map((value) => {
    return value.trim()
  })
  if (parts.length !== 2) {
    return new Error(`Invalid point \"${input}\". Expected x,y`)
  }
  const x = Number(parts[0])
  const y = Number(parts[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return new Error(`Invalid point \"${input}\". Coordinates must be numbers`)
  }
  return { x, y }
}

export function parseRegion(input: string): Error | Region {
  const parts = input.split(',').map((value) => {
    return value.trim()
  })
  if (parts.length !== 4) {
    return new Error(`Invalid region \"${input}\". Expected x,y,width,height`)
  }
  const x = Number(parts[0])
  const y = Number(parts[1])
  const width = Number(parts[2])
  const height = Number(parts[3])
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return new Error(`Invalid region \"${input}\". Values must be numbers`)
  }
  if (width <= 0 || height <= 0) {
    return new Error(`Invalid region \"${input}\". Width and height must be greater than 0`)
  }
  return { x, y, width, height }
}

export function parseModifiers(input?: string): string[] {
  if (!input) {
    return []
  }
  return input
    .split(',')
    .map((value) => {
      return value.trim().toLowerCase()
    })
    .filter((value) => {
      return value.length > 0
    })
}

export function parseDirection(input: string): Error | ScrollDirection {
  const normalized = input.trim().toLowerCase()
  if (normalized === 'up' || normalized === 'down' || normalized === 'left' || normalized === 'right') {
    return normalized
  }
  return new Error(`Invalid direction \"${input}\". Expected up, down, left, or right`)
}
