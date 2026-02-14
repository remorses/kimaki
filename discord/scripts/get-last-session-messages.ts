#!/usr/bin/env tsx
import { createOpencodeClient } from '@opencode-ai/sdk'
import { spawn } from 'node:child_process'
import net from 'node:net'

async function getOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => {
          resolve(port)
        })
      } else {
        reject(new Error('Failed to get port'))
      }
    })
    server.on('error', reject)
  })
}

async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const endpoints = [
        `http://localhost:${port}/api/health`,
        `http://localhost:${port}/`,
        `http://localhost:${port}/api`,
      ]

      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint)
          if (response.status < 500) {
            console.log(`Server ready on port ${port}`)
            return true
          }
        } catch (e) {
          // expected during polling, server not ready yet
        }
      }
    } catch (e) {
      // expected during polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Server did not start on port ${port} after ${maxAttempts} seconds`)
}

async function getLastSessionMessages() {
  // Get a free port
  const port = await getOpenPort()
  const baseUrl = `http://localhost:${port}`

  console.log(`Starting OpenCode server on port ${port}...`)

  const opencodeCommand = process.env.OPENCODE_PATH || 'opencode'
  const directory = process.cwd()

  // Start the OpenCode server
  const serverProcess = spawn(opencodeCommand, ['serve', '--port', port.toString()], {
    stdio: 'pipe',
    detached: false,
    cwd: directory,
    env: {
      ...process.env,
      OPENCODE_PORT: port.toString(),
    },
  })

  serverProcess.stdout?.on('data', (data) => {
    console.log(`[opencode]: ${data.toString().trim()}`)
  })

  serverProcess.stderr?.on('data', (data) => {
    console.error(`[opencode error]: ${data.toString().trim()}`)
  })

  serverProcess.on('error', (error) => {
    console.error('Failed to start OpenCode server:', error)
    process.exit(1)
  })

  serverProcess.on('exit', (code) => {
    console.log(`OpenCode server exited with code: ${code}`)
  })

  // Wait for server to be ready
  await waitForServer(port)

  const client = createOpencodeClient({ baseUrl })

  console.log('=== Fetching Last Session Messages ===\n')

  try {
    // Get the current project first
    const currentProjectResponse = await client.project.current()
    if (!currentProjectResponse.data) {
      console.error('Failed to fetch current project')
      return
    }
    const currentProject = currentProjectResponse.data
    console.log(`Current Project: ${currentProject.id}`)
    console.log(`Worktree: ${currentProject.worktree}\n`)

    // Get all sessions for the current project
    const sessionsResponse = await client.session.list()
    if (!sessionsResponse.data) {
      console.error('Failed to fetch sessions')
      return
    }

    const projectSessions = sessionsResponse.data.filter((s) => s.projectID === currentProject.id)

    if (projectSessions.length === 0) {
      console.log('No sessions found for the current project')
      return
    }

    // Sort sessions by update time and get the latest one
    const latestSession = projectSessions.sort((a, b) => b.time.updated - a.time.updated)[0]

    console.log(`Latest Session: "${latestSession.title}"`)
    console.log(`Session ID: ${latestSession.id}`)
    console.log(`Last Updated: ${new Date(latestSession.time.updated).toLocaleString()}\n`)

    // Get messages for the session
    const messagesResponse = await client.session.messages({
      path: { id: latestSession.id },
    })

    if (!messagesResponse.data) {
      console.error('Failed to fetch session messages')
      return
    }

    const messages = messagesResponse.data
    console.log(`Found ${messages.length} message(s) in the session\n`)

    // Log the messages as prettified JSON
    console.log('=== Session Messages (JSON) ===\n')
    console.log(JSON.stringify(messages, null, 2))
  } catch (error) {
    console.error('Error fetching session messages:', error)
    serverProcess.kill()
    process.exit(1)
  } finally {
    // Kill the server process when done
    serverProcess.kill()
    process.exit(0)
  }
}

getLastSessionMessages().catch(console.error)
