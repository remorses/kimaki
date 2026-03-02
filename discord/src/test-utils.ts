// Shared e2e test utilities for session and server cleanup.
// Extracted from individual test files to avoid duplication.
// Uses directory + start timestamp double-filter to ensure we only
// delete sessions created by this specific test run, never real user sessions.
//
// Prefers using the existing opencode client (already running server) to avoid
// spawning a new server process during teardown. Falls back to initializing
// a new server only if no existing client is available.

import {
  getOpencodeClient,
  getOpencodeServers,
  initializeOpencodeForDirectory,
} from './opencode.js'

/**
 * Kill all in-memory opencode server processes and clear the registry.
 * Does NOT delete sessions from the opencode DB — call cleanupTestSessions for that.
 */
export async function cleanupOpencodeServers() {
  const servers = getOpencodeServers()
  for (const [, server] of servers) {
    if (!server.process.killed) {
      server.process.kill('SIGTERM')
    }
  }
  servers.clear()
}

/**
 * Delete all opencode sessions created during a test run.
 * Uses directory + start timestamp to scope strictly to test sessions.
 * Prefers the existing in-memory client to avoid spawning a new server in teardown.
 * Errors are caught silently — cleanup should never fail tests.
 */
export async function cleanupTestSessions({
  projectDirectory,
  testStartTime,
}: {
  projectDirectory: string
  testStartTime: number
}) {
  // Prefer existing client to avoid spawning a new server during teardown
  const existingClient = getOpencodeClient(projectDirectory)
  const client = existingClient || await (async () => {
    const getClient = await initializeOpencodeForDirectory(projectDirectory).catch(() => {
      return null
    })
    if (!getClient || getClient instanceof Error) return null
    return getClient()
  })()
  if (!client) return

  const listResult = await client.session.list({
    directory: projectDirectory,
    start: testStartTime,
    limit: 1000,
  }).catch(() => {
    return null
  })
  const sessions = listResult?.data ?? []
  await Promise.all(
    sessions.map((s) => {
      return client.session.delete({
        sessionID: s.id,
        directory: projectDirectory,
      }).catch(() => {
        return
      })
    }),
  )
}
