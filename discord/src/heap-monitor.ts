// Heap memory monitor and snapshot writer.
// Periodically checks V8 heap usage and writes .heapsnapshot files to ~/.kimaki/heap-snapshots/
// when memory usage is high. Also exposes writeHeapSnapshot() for on-demand snapshots via SIGUSR1.
//
// Threshold: 85% heap used -> write snapshot for debugging

import v8 from 'node:v8'
import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.HEAP)

const SNAPSHOT_THRESHOLD = 0.85
const CHECK_INTERVAL_MS = 30_000
// After writing a snapshot, wait at least 5 minutes before writing another
const SNAPSHOT_COOLDOWN_MS = 5 * 60 * 1000

let lastSnapshotTime = 0
let monitorInterval: ReturnType<typeof setInterval> | null = null

function getHeapSnapshotDir(): string {
  return path.join(getDataDir(), 'heap-snapshots')
}

function ensureSnapshotDir(): string {
  const dir = getHeapSnapshotDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

function getHeapStats(): { usedMB: number; limitMB: number; ratio: number } {
  const stats = v8.getHeapStatistics()
  const usedMB = stats.used_heap_size / 1024 / 1024
  const limitMB = stats.heap_size_limit / 1024 / 1024
  const ratio = stats.used_heap_size / stats.heap_size_limit
  return { usedMB, limitMB, ratio }
}

/**
 * Write a V8 heap snapshot to ~/.kimaki/heap-snapshots/.
 * Filename includes ISO date and current heap size for easy identification.
 * Returns the snapshot file path.
 */
export function writeHeapSnapshot(): string {
  const dir = ensureSnapshotDir()
  const { usedMB, limitMB, ratio } = getHeapStats()
  const pct = (ratio * 100).toFixed(1)

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `heap-${timestamp}-${Math.round(usedMB)}MB.heapsnapshot`
  const filepath = path.join(dir, filename)

  logger.log(`Writing heap snapshot (${Math.round(usedMB)}MB / ${Math.round(limitMB)}MB, ${pct}%)`)
  v8.writeHeapSnapshot(filepath)
  logger.log(`Snapshot saved: ${filepath}`)

  return filepath
}

function checkHeapUsage(): void {
  const { usedMB, limitMB, ratio } = getHeapStats()
  const pct = (ratio * 100).toFixed(1)

  if (ratio >= SNAPSHOT_THRESHOLD) {
    logger.warn(
      `Heap at ${pct}% (${Math.round(usedMB)}MB / ${Math.round(limitMB)}MB) - exceeds snapshot threshold (${SNAPSHOT_THRESHOLD * 100}%)`,
    )

    const now = Date.now()
    if (now - lastSnapshotTime >= SNAPSHOT_COOLDOWN_MS) {
      lastSnapshotTime = now
      writeHeapSnapshot()
    } else {
      logger.log('Snapshot cooldown active, skipping')
    }
  }
}

/**
 * Start the periodic heap usage monitor.
 * Checks every 30s and writes snapshots when threshold is exceeded.
 */
export function startHeapMonitor(): void {
  if (monitorInterval) {
    return
  }

  const { usedMB, limitMB, ratio } = getHeapStats()
  logger.log(
    `Heap monitor started (${Math.round(usedMB)}MB / ${Math.round(limitMB)}MB, ${(ratio * 100).toFixed(1)}%) - ` +
      `snapshot at ${SNAPSHOT_THRESHOLD * 100}%`,
  )

  monitorInterval = setInterval(checkHeapUsage, CHECK_INTERVAL_MS)
  // Don't prevent process exit
  monitorInterval.unref()
}

export function stopHeapMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval)
    monitorInterval = null
  }
}
