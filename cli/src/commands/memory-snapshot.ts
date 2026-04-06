// /memory-snapshot command - Write a V8 heap snapshot and show the file path.
// Reuses writeHeapSnapshot() from heap-monitor.ts which writes gzip-compressed
// .heapsnapshot.gz files to ~/.kimaki/heap-snapshots/.

import { MessageFlags } from 'discord.js'
import type { CommandContext } from './types.js'
import { writeHeapSnapshot } from '../heap-monitor.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.HEAP)

export async function handleMemorySnapshotCommand({
  command,
}: CommandContext): Promise<void> {
  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  try {
    const filepath = await writeHeapSnapshot()
    await command.editReply({
      content: `Heap snapshot written:\n\`${filepath}\``,
    })
    logger.log(`Memory snapshot requested via /memory-snapshot: ${filepath}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await command.editReply({
      content: `Failed to write heap snapshot: ${msg}`,
    })
  }
}
