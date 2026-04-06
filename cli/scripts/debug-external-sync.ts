#!/usr/bin/env tsx

import { listTrackedTextChannels } from '../src/database.js'
import {
  externalOpencodeSyncInternals,
} from '../src/external-opencode-sync.js'
import { initializeOpencodeForDirectory } from '../src/opencode.js'

async function main() {
  const trackedChannels = await listTrackedTextChannels()
  const directoryTargets = externalOpencodeSyncInternals.groupTrackedChannelsByDirectory(
    trackedChannels,
  )

  if (directoryTargets.length === 0) {
    console.log('No tracked text channels found.')
    return
  }

  console.log('Tracked directory targets:')
  directoryTargets.forEach((target) => {
    console.log(`- ${target.directory} -> ${target.channelId} (start ${new Date(target.startMs).toISOString()})`)
  })
  console.log('')

  for (const target of directoryTargets) {
    const clientResult = await initializeOpencodeForDirectory(target.directory, {
      channelId: target.channelId,
    })
    if (clientResult instanceof Error) {
      console.log(`Directory ${target.directory}`)
      console.log(`  init: error (${clientResult.message})`)
      console.log('')
      continue
    }

    const client = clientResult()
    const sessionsResponse = await client.session.list({
      directory: target.directory,
      start: target.startMs,
      limit: 50,
    }).catch((error) => {
      return new Error(`Failed to list sessions for ${target.directory}`, {
        cause: error,
      })
    })
    if (sessionsResponse instanceof Error) {
      console.log(`Directory ${target.directory}`)
      console.log(`  list: error (${sessionsResponse.message})`)
      console.log('')
      continue
    }

    const sessions = sessionsResponse.data || []
    console.log(`Directory ${target.directory}`)
    console.log(`  listed sessions: ${sessions.length}`)
    console.log('')

    for (const session of sessions) {
      const placeholderTitle = /^new session\s*-/i.test(session.title || '')

      console.log(`Session ${session.id}`)
      console.log(`  title: ${session.title}`)
      console.log(`  directory: ${target.directory}`)
      if (placeholderTitle) {
        console.log('  status: skip (placeholder_title)')
        console.log('')
        continue
      }

      const messagesResponse = await client.session.messages({
        sessionID: session.id,
        directory: target.directory,
      }).catch((error) => {
        return new Error(`Failed to fetch messages for session ${session.id}`, {
          cause: error,
        })
      })
      if (messagesResponse instanceof Error) {
        console.log(`  status: error (${messagesResponse.message})`)
        console.log('')
        continue
      }

      const messages = messagesResponse.data || []
      const latestUserTurnFromDiscord = externalOpencodeSyncInternals.isLatestUserTurnFromDiscord({
        messages,
      })

      console.log(
        `  status: ${latestUserTurnFromDiscord ? 'skip (latest-user-from-discord)' : 'sync'}`,
      )
      console.log('')
    }
  }
}

void main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
