// Shared coord-map helpers for converting screenshot-space pixels to desktop coordinates.

import type { CoordMap, Point, Region } from './types.js'

export function parseCoordMapOrThrow(input?: string): CoordMap | undefined {
  if (!input) {
    return undefined
  }

  const values = input.split(',').map((value) => {
    return Number(value.trim())
  })
  if (values.length !== 6 || values.some((value) => {
    return !Number.isFinite(value)
  })) {
    throw new Error('Option --coord-map must be x,y,width,height,imageWidth,imageHeight')
  }

  const [captureX, captureY, captureWidth, captureHeight, imageWidth, imageHeight] = values
  if (captureWidth <= 0 || captureHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    throw new Error('Option --coord-map must have positive width and height values')
  }

  return {
    captureX,
    captureY,
    captureWidth,
    captureHeight,
    imageWidth,
    imageHeight,
  }
}

export function mapPointFromCoordMap({
  point,
  coordMap,
}: {
  point: Point
  coordMap?: CoordMap
}): Point {
  if (!coordMap) {
    return point
  }

  const imageWidthSpan = Math.max(coordMap.imageWidth - 1, 1)
  const imageHeightSpan = Math.max(coordMap.imageHeight - 1, 1)
  const captureWidthSpan = Math.max(coordMap.captureWidth - 1, 0)
  const captureHeightSpan = Math.max(coordMap.captureHeight - 1, 0)
  const maxCaptureX = coordMap.captureX + captureWidthSpan
  const maxCaptureY = coordMap.captureY + captureHeightSpan
  const mappedX = coordMap.captureX + (point.x / imageWidthSpan) * captureWidthSpan
  const mappedY = coordMap.captureY + (point.y / imageHeightSpan) * captureHeightSpan
  const clampedX = Math.max(coordMap.captureX, Math.min(maxCaptureX, mappedX))
  const clampedY = Math.max(coordMap.captureY, Math.min(maxCaptureY, mappedY))

  return {
    x: Math.round(clampedX),
    y: Math.round(clampedY),
  }
}

export function mapPointToCoordMap({
  point,
  coordMap,
}: {
  point: Point
  coordMap?: CoordMap
}): Point {
  if (!coordMap) {
    return point
  }

  const captureWidthSpan = Math.max(coordMap.captureWidth - 1, 1)
  const captureHeightSpan = Math.max(coordMap.captureHeight - 1, 1)
  const imageWidthSpan = Math.max(coordMap.imageWidth - 1, 0)
  const imageHeightSpan = Math.max(coordMap.imageHeight - 1, 0)
  const relativeX = (point.x - coordMap.captureX) / captureWidthSpan
  const relativeY = (point.y - coordMap.captureY) / captureHeightSpan
  const mappedX = relativeX * imageWidthSpan
  const mappedY = relativeY * imageHeightSpan
  const clampedX = Math.max(0, Math.min(imageWidthSpan, mappedX))
  const clampedY = Math.max(0, Math.min(imageHeightSpan, mappedY))

  return {
    x: Math.round(clampedX),
    y: Math.round(clampedY),
  }
}

export function getRegionFromCoordMap({
  coordMap,
}: {
  coordMap?: CoordMap
}): Region | undefined {
  if (!coordMap) {
    return undefined
  }

  return {
    x: coordMap.captureX,
    y: coordMap.captureY,
    width: coordMap.captureWidth,
    height: coordMap.captureHeight,
  }
}
