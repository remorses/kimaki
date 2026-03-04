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
  /** Percent of non-idle active samples */
  activePercent: number
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

  // Count self-time samples per node
  const selfCounts = new Map<number, number>()
  for (const id of profile.samples) {
    selfCounts.set(id, (selfCounts.get(id) || 0) + 1)
  }

  const totalSamples = profile.samples.length
  const nonIdleSamples = [...selfCounts.entries()]
    .filter(([id]) => {
      const node = nodes.get(id)
      return node ? !IDLE_NAMES.has(node.callFrame.functionName) : false
    })
    .reduce((sum, [, count]) => sum + count, 0)

  // Aggregate by function identity (name + url + line)
  const fnMap = new Map<string, FunctionStat>()
  for (const [id, count] of selfCounts) {
    const node = nodes.get(id)
    if (!node) {
      continue
    }
    const { functionName, url, lineNumber } = node.callFrame
    if (IDLE_NAMES.has(functionName)) {
      continue
    }
    const key = `${functionName}|${url}|${lineNumber}`
    const existing = fnMap.get(key)
    if (existing) {
      existing.selfSamples += count
    } else {
      fnMap.set(key, {
        functionName: functionName || '(anonymous)',
        url,
        lineNumber,
        selfSamples: count,
        selfPercent: 0,
        activePercent: 0,
      })
    }
  }

  // Compute percentages
  const functions: FunctionStat[] = [...fnMap.values()]
    .map((fn) => {
      return {
        ...fn,
        selfPercent: totalSamples > 0 ? (fn.selfSamples / totalSamples) * 100 : 0,
        activePercent: nonIdleSamples > 0 ? (fn.selfSamples / nonIdleSamples) * 100 : 0,
      }
    })
    .sort((a, b) => b.selfSamples - a.selfSamples)

  const durationSeconds = (profile.endTime - profile.startTime) / 1e6

  return { durationSeconds, totalSamples, nonIdleSamples, functions }
}
