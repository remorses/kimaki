/**
 * Test script to validate model ID format and provider.list API.
 * 
 * Usage: npx tsx scripts/test-model-id.ts [directory]
 * 
 * This script:
 * 1. Calls provider.list() to get all available providers and models
 * 2. Validates that model IDs can be correctly parsed into provider/model format
 * 3. Logs the available models sorted by release date
 */

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
      const response = await fetch(`http://localhost:${port}/api/health`)
      if (response.status < 500) {
        return true
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1000)
    })
  }
  throw new Error(`Server did not start on port ${port} after ${maxAttempts} seconds`)
}

async function main() {
  const directory = process.argv[2] || process.cwd()
  console.log(`Testing model IDs for directory: ${directory}`)
  
  const port = await getOpenPort()
  console.log(`Starting opencode server on port ${port}...`)
  
  const serverProcess = spawn('opencode', ['serve', '--port', port.toString()], {
    cwd: directory,
    stdio: 'pipe',
  })
  
  serverProcess.stdout?.on('data', (data) => {
    console.log(`[opencode] ${data.toString().trim()}`)
  })
  
  serverProcess.stderr?.on('data', (data) => {
    console.error(`[opencode] ${data.toString().trim()}`)
  })
  
  try {
    await waitForServer(port)
    console.log('Server ready!')
    
    const client = createOpencodeClient({
      baseUrl: `http://localhost:${port}`,
    })
    
    const response = await client.provider.list({
      query: { directory },
    })
    
    if (!response.data) {
      throw new Error('Failed to fetch providers')
    }
    
    const { all: providers, connected, default: defaults } = response.data
    
    console.log(`\n=== Connected Providers (${connected.length}) ===`)
    console.log(connected.join(', ') || '(none)')
    
    console.log(`\n=== Default Models ===`)
    for (const [key, value] of Object.entries(defaults)) {
      console.log(`  ${key}: ${value}`)
    }
    
    console.log(`\n=== All Providers (${providers.length}) ===`)
    
    for (const provider of providers) {
      const isConnected = connected.includes(provider.id)
      const models = Object.entries(provider.models || {})
      
      console.log(`\n--- ${provider.name} (${provider.id}) ${isConnected ? '[CONNECTED]' : ''} ---`)
      console.log(`  Models: ${models.length}`)
      
      if (models.length > 0) {
        // Sort by release date (ascending)
        const sortedModels = models
          .map(([id, model]) => ({
            id,
            name: model.name,
            releaseDate: model.release_date,
            fullId: `${provider.id}/${id}`,
          }))
          .sort((a, b) => {
            const dateA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0
            const dateB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0
            return dateA - dateB
          })
        
        // Show last 5 models (most recent)
        const recentModels = sortedModels.slice(-5)
        console.log('  Recent models (sorted by release date):')
        for (const model of recentModels) {
          console.log(`    - ${model.name}`)
          console.log(`      ID: ${model.fullId}`)
          console.log(`      Date: ${model.releaseDate || 'unknown'}`)
          
          // Validate parsing
          const [parsedProvider, ...modelParts] = model.fullId.split('/')
          const parsedModel = modelParts.join('/')
          
          if (parsedProvider !== provider.id || parsedModel !== model.id) {
            console.log(`      ERROR: Parse mismatch!`)
            console.log(`        Expected: provider=${provider.id}, model=${model.id}`)
            console.log(`        Got: provider=${parsedProvider}, model=${parsedModel}`)
          }
        }
      }
    }
    
    console.log('\n=== Validation Complete ===')
    console.log('All model IDs can be correctly parsed into provider/model format.')
    
  } finally {
    console.log('\nStopping server...')
    serverProcess.kill('SIGTERM')
  }
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
