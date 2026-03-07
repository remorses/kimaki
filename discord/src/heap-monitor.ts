// Heap memory monitor and snapshot writer.
// Periodically checks V8 heap usage and writes gzip-compressed .heapsnapshot.gz
// files to ~/.kimaki/heap-snapshots/ when memory usage is high.
// Also exposes writeHeapSnapshot() for on-demand snapshots via SIGUSR1.
//
// Snapshots use v8.getHeapSnapshot() streaming API piped through gzip for ~5-10x
// size reduction (heap snapshots are JSON, so they compress very well).
//
// Only active in development (detected by import.meta.filename ending in .ts).
// In production (compiled .js from npm), the monitor is a no-op to avoid filling
// user disks with multi-GB snapshot files.
//
// Threshold: 85% heap used -> write snapshot for debugging

import v8 from 'node:v8'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { getDataDir } from './config.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.HEAP)

const SNAPSHOT_THRESHOLD = 0.85
const CHECK_INTERVAL_MS = 30_000
// After writing a snapshot, wait at least 5 minutes before writing another
const SNAPSHOT_COOLDOWN_MS = 5 * 60 * 1000

// Development detection: if this file is .ts we're running from source (tsx/ts-node).
// Compiled npm package runs from .js files.
const isDevelopment = fileURLToPath(import.meta.url).endsWith('.ts')

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
 * Write a gzip-compressed V8 heap snapshot to ~/.kimaki/heap-snapshots/.
 * Uses v8.getHeapSnapshot() streaming API piped through gzip for ~5-10x
 * size reduction compared to v8.writeHeapSnapshot().
 * Filename includes ISO date and current heap size for easy identification.
 * Returns the snapshot file path.
 */
export async function writeHeapSnapshot(): Promise<string> {
  const dir = ensureSnapshotDir()
  const { usedMB, limitMB, ratio } = getHeapStats()
  const pct = (ratio * 100).toFixed(1)

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `heap-${timestamp}-${Math.round(usedMB)}MB.heapsnapshot.gz`
  const filepath = path.join(dir, filename)

  logger.log(
    `Writing compressed heap snapshot (${Math.round(usedMB)}MB / ${Math.round(limitMB)}MB, ${pct}%)`,
  )

  const snapshotStream = v8.getHeapSnapshot()
  const gzipStream = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED })
  const fileStream = fs.createWriteStream(filepath)

  await pipeline(snapshotStream, gzipStream, fileStream)

  const fileSizeMB = (fs.statSync(filepath).size / 1024 / 1024).toFixed(1)
  logger.log(`Snapshot saved: ${filepath} (${fileSizeMB}MB compressed)`)

  return filepath
}

async function checkHeapUsage(): Promise<void> {
  const { usedMB, limitMB, ratio } = getHeapStats()
  const pct = (ratio * 100).toFixed(1)

  if (ratio >= SNAPSHOT_THRESHOLD) {
    logger.warn(
      `Heap at ${pct}% (${Math.round(usedMB)}MB / ${Math.round(limitMB)}MB) - exceeds snapshot threshold (${SNAPSHOT_THRESHOLD * 100}%)`,
    )

    const now = Date.now()
    if (now - lastSnapshotTime >= SNAPSHOT_COOLDOWN_MS) {
      lastSnapshotTime = now
      try {
        await writeHeapSnapshot()
      } catch (e) {
        logger.error(
          'Failed to write heap snapshot:',
          e instanceof Error ? e.message : String(e),
        )
      }
    } else {
      logger.log('Snapshot cooldown active, skipping')
    }
  }
}

/**
 * Start the periodic heap usage monitor.
 * Checks every 30s and writes snapshots when threshold is exceeded.
 * Only active in development (running from .ts source). In production
 * (compiled .js from npm), this is a no-op to avoid filling user disks.
 */
export function startHeapMonitor(): void {
  if (!isDevelopment) {
    return
  }
  if (monitorInterval) {
    return
  }

  // Ensure the snapshot directory exists so V8's --diagnostic-dir has a valid target.
  // Also needed for our own writeHeapSnapshot() calls.
  ensureSnapshotDir()

  const { usedMB, limitMB, ratio } = getHeapStats()
  logger.log(
    `Heap monitor started (${Math.round(usedMB)}MB / ${Math.round(limitMB)}MB, ${(ratio * 100).toFixed(1)}%) - ` +
      `snapshot at ${SNAPSHOT_THRESHOLD * 100}%`,
  )

  monitorInterval = setInterval(() => {
    void checkHeapUsage()
  }, CHECK_INTERVAL_MS)
  // Don't prevent process exit
  monitorInterval.unref()
}

export function stopHeapMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval)
    monitorInterval = null
  }
}
