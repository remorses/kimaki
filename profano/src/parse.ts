// Parse V8 .cpuprofile files and compute self-time / total-time per node.
// The .cpuprofile format is a JSON object with:
//   nodes: array of { id, callFrame: { functionName, url, lineNumber, ... }, children?: number[] }
//   samples: array of node IDs (one per sampling tick)
//   startTime / endTime: microseconds
//   timeDeltas: array of microsecond deltas between samples

import fs from 'node:fs'

export interface CallFrame {
  functionName: string
  url: string
  scriptId: string
  lineNumber: number
  columnNumber: number
}

export interface ProfileNode {
  id: number
  callFrame: CallFrame
  children?: number[]
}

export interface CpuProfile {
  nodes: ProfileNode[]
  samples: number[]
  startTime: number
  endTime: number
  timeDeltas?: number[]
}

export interface FunctionStat {
  functionName: string
  url: string
  lineNumber: number
  selfSamples: number
  selfPercent: number
  /** Percent of non-idle active samples (self) */
  activePercent: number
  totalSamples: number
  totalPercent: number
  /** Percent of non-idle active samples (total/inclusive) */
  totalActivePercent: number
}

const IDLE_NAMES = new Set(['(idle)', '(garbage collector)', '(program)', '(root)'])

export function loadProfile(filePath: string): CpuProfile {
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(raw) as CpuProfile
}

export function analyze(profile: CpuProfile): {
  durationSeconds: number
  totalSamples: number
  nonIdleSamples: number
  functions: FunctionStat[]
} {
  const nodes = new Map<number, ProfileNode>()
  for (const node of profile.nodes) {
    nodes.set(node.id, node)
  }

  // Build parent map for walking up the call stack
  const parentMap = new Map<number, number>()
  for (const node of profile.nodes) {
    if (node.children) {
      for (const childId of node.children) {
        parentMap.set(childId, node.id)
      }
    }
  }

  // Count self-time samples per node
  const selfCounts = new Map<number, number>()
  for (const id of profile.samples) {
    selfCounts.set(id, (selfCounts.get(id) || 0) + 1)
  }

  // Count total-time (inclusive) samples per node.
  // For each sample, walk from the sampled node up to root,
  // counting each ancestor once per sample.
  const totalCounts = new Map<number, number>()
  for (const id of profile.samples) {
    const visited = new Set<number>()
    let current: number | undefined = id
    while (current !== undefined) {
      if (visited.has(current)) break
      visited.add(current)
      totalCounts.set(current, (totalCounts.get(current) || 0) + 1)
      current = parentMap.get(current)
    }
  }

  const sampleCount = profile.samples.length
  const nonIdleSamples = [...selfCounts.entries()]
    .filter(([id]) => {
      const node = nodes.get(id)
      return node ? !IDLE_NAMES.has(node.callFrame.functionName) : false
    })
    .reduce((sum, [, count]) => sum + count, 0)

  // Aggregate by function identity (name + url + line).
  // Collect both self and total counts from all nodes with the same identity.
  const fnMap = new Map<string, FunctionStat>()
  for (const node of profile.nodes) {
    const { functionName, url, lineNumber } = node.callFrame
    if (IDLE_NAMES.has(functionName)) continue
    const self = selfCounts.get(node.id) || 0
    const total = totalCounts.get(node.id) || 0
    if (self === 0 && total === 0) continue

    const key = `${functionName}|${url}|${lineNumber}`
    const existing = fnMap.get(key)
    if (existing) {
      existing.selfSamples += self
      existing.totalSamples += total
    } else {
      fnMap.set(key, {
        functionName: functionName || '(anonymous)',
        url,
        lineNumber,
        selfSamples: self,
        selfPercent: 0,
        activePercent: 0,
        totalSamples: total,
        totalPercent: 0,
        totalActivePercent: 0,
      })
    }
  }

  // Compute percentages, sort by self-time by default
  const functions: FunctionStat[] = [...fnMap.values()]
    .map((fn) => ({
      ...fn,
      selfPercent: sampleCount > 0 ? (fn.selfSamples / sampleCount) * 100 : 0,
      activePercent: nonIdleSamples > 0 ? (fn.selfSamples / nonIdleSamples) * 100 : 0,
      totalPercent: sampleCount > 0 ? (fn.totalSamples / sampleCount) * 100 : 0,
      totalActivePercent: nonIdleSamples > 0 ? (fn.totalSamples / nonIdleSamples) * 100 : 0,
    }))
    .sort((a, b) => b.selfSamples - a.selfSamples)

  const durationSeconds = (profile.endTime - profile.startTime) / 1e6

  return { durationSeconds, totalSamples: sampleCount, nonIdleSamples, functions }
}
