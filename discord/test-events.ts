import {
  createOpencodeClient,
  type OpencodeClient,
  type Part,
  type Event,
} from '@opencode-ai/sdk'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

let serverProcess: ChildProcess | null = null
let client: OpencodeClient | null = null

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
            console.log(`✅ OpenCode server ready on port ${port}`)
            return true
          }
        } catch (e) {}
      }
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(
    `Server did not start on port ${port} after ${maxAttempts} seconds`,
  )
}

async function initializeOpencode() {
  if (!serverProcess || serverProcess.killed) {
    const port = await getOpenPort()
    console.log(`🚀 Starting OpenCode server on port ${port}...`)

    serverProcess = spawn('opencode', ['serve', '--port', port.toString()], {
      stdio: 'pipe',
      detached: false,
      env: {
        ...process.env,
        OPENCODE_PORT: port.toString(),
      },
    })

    serverProcess.stdout?.on('data', (data) => {
      console.log(`[OpenCode] ${data.toString().trim()}`)
    })

    serverProcess.stderr?.on('data', (data) => {
      console.error(`[OpenCode Error] ${data.toString().trim()}`)
    })

    serverProcess.on('error', (error) => {
      console.error('Failed to start OpenCode server:', error)
    })

    await waitForServer(port)
    client = createOpencodeClient({ baseUrl: `http://localhost:${port}` })
  }

  return client!
}

async function testEventListener() {
  const client = await initializeOpencode()
  
  console.log('📡 Subscribing to events...')
  const eventsResult = await client.event.subscribe()
  const events = eventsResult.stream
  
  console.log('✅ Connected! Listening for events...\n')
  
  // Create a session and send a test message
  console.log('📤 Creating a session and sending a test message...')
  
  const sessionResponse = await client.session.create({
    body: { title: 'Test Event Listener Session' }
  })
  
  const session = sessionResponse.data
  if (!session) {
    throw new Error('Failed to create session')
  }
  
  console.log(`✅ Session created: ${session.id}`)
  
  // Send the test prompt asynchronously (don't await)
  const prompt = 'run bash command to list files, then read each one'
  console.log(`📨 Sending prompt: "${prompt}"\n`)
  
  client.session.prompt({
    path: { id: session.id },
    body: {
      parts: [{ type: 'text', text: prompt }],
    },
  }).then(response => {
    console.log('\n✅ Prompt completed!')
    console.log(`   Message ID: ${response.data?.id}`)
    console.log(`   Parts count: ${response.data?.parts?.length || 0}`)
  }).catch(error => {
    console.error('\n❌ Prompt error:', error)
  })
  
  for await (const event of events) {
    if (event.type === 'message.part.updated') {
      const part = event.properties.part
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log(`📦 Event: ${event.type}`)
      console.log(`   Session: ${part.sessionID}`)
      console.log(`   Message: ${part.messageID}`)
      console.log(`   Part ID: ${part.id}`)
      console.log(`   Type: ${part.type}`)
      
      switch (part.type) {
        case 'text':
          console.log(`   Content: ${part.text || '(empty)'}`)
          break
        case 'reasoning':
          console.log(`   Reasoning: ${part.text || '(empty)'}`)
          break
        case 'tool':
          console.log(`   Tool: ${part.tool}`)
          console.log(`   Status: ${part.state?.status || 'pending'}`)
          if (part.state?.title) {
            console.log(`   Title: ${part.state.title}`)
          }
          if (part.state?.output) {
            const output = part.state.output.slice(0, 200)
            console.log(`   Output: ${output}${part.state.output.length > 200 ? '...' : ''}`)
          }
          break
        case 'file':
          console.log(`   Filename: ${part.filename || 'unknown'}`)
          break
        default:
          console.log(`   Unknown part type: ${JSON.stringify(part)}`)
      }
    } else if (event.type === 'message.updated') {
      console.log(`📨 Event: ${event.type} - Session: ${event.properties.info.sessionID}`)
    } else if (event.type === 'session.error') {
      console.log(`❌ Event: ${event.type} - Error: ${event.properties.error?.data?.message || 'Unknown error'}`)
    } else {
      console.log(`🔔 Event: ${event.type}`)
    }
  }
}

// Clean up on exit
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down...')
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM')
  }
  process.exit(0)
})

process.on('SIGTERM', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM')
  }
  process.exit(0)
})

// Run the test
console.log('🚀 OpenCode Event Test Script')
console.log('   This will start an OpenCode server and print all events')
console.log('   Press Ctrl+C to exit\n')

testEventListener().catch((error) => {
  console.error('❌ Error:', error)
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM')
  }
  process.exit(1)
})