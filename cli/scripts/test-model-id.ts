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

import { OpenCode } from '@opencode/client'
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
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
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
  throw new Error(
    `Server did not start on port ${port} after ${maxAttempts} seconds`,
  )
}

async function main() {
  const directory = process.argv[2] || process.cwd()
  console.log(`Testing model IDs for directory: ${directory}`)

  const port = await getOpenPort()
  console.log(`Starting opencode server on port ${port}...`)

  const serverProcess = spawn(
    'opencode',
    ['serve', '--port', port.toString()],
    {
      cwd: directory,
      stdio: 'pipe',
    },
  )

  serverProcess.stdout?.on('data', (data) => {
    console.log(`[opencode] ${data.toString().trim()}`)
  })

  serverProcess.stderr?.on('data', (data) => {
    console.error(`[opencode] ${data.toString().trim()}`)
  })

  try {
    await waitForServer(port)
    console.log('Server ready!')

    const client = OpenCode.make({
      baseUrl: `http://127.0.0.1:${port}`,
    })

    const [providerResponse, modelResponse] = await Promise.all([
      client.provider.list({ location: { directory } }),
      client.model.list({ location: { directory } }),
    ])
    const providers = providerResponse.data
    const models = modelResponse.data
    const enabledProviders = providers.filter((provider) => {
      return provider.activation !== 'disabled'
    })

    console.log(`\n=== Enabled Providers (${enabledProviders.length}) ===`)
    console.log(enabledProviders.map((provider) => provider.id).join(', ') || '(none)')

    console.log(`\n=== All Providers (${providers.length}) ===`)

    for (const provider of providers) {
      const providerModels = models.filter((model) => {
        return model.providerID === provider.id
      })

      console.log(
        `\n--- ${provider.name} (${provider.id}) ${provider.activation !== 'disabled' ? '[ENABLED]' : ''} ---`,
      )
      console.log(`  Models: ${providerModels.length}`)

      if (providerModels.length > 0) {
        // Sort by release date (ascending)
        const sortedModels = providerModels
          .map((model) => ({
            id: model.modelID,
            name: model.name,
            releaseDate: model.time.released,
            fullId: model.id,
          }))
          .sort((a, b) => {
            return a.releaseDate - b.releaseDate
          })

        // Show last 5 models (most recent)
        const recentModels = sortedModels.slice(-5)
        console.log('  Recent models (sorted by release date):')
        for (const model of recentModels) {
          console.log(`    - ${model.name}`)
          console.log(`      ID: ${model.fullId}`)
          console.log(`      Date: ${new Date(model.releaseDate).toISOString()}`)

          // Validate parsing
          const [parsedProvider, ...modelParts] = model.fullId.split('/')
          const parsedModel = modelParts.join('/')

          if (parsedProvider !== provider.id || parsedModel !== model.id) {
            console.log(`      ERROR: Parse mismatch!`)
            console.log(
              `        Expected: provider=${provider.id}, model=${model.id}`,
            )
            console.log(
              `        Got: provider=${parsedProvider}, model=${parsedModel}`,
            )
          }
        }
      }
    }

    console.log('\n=== Validation Complete ===')
    console.log(
      'All model IDs can be correctly parsed into provider/model format.',
    )
  } finally {
    console.log('\nStopping server...')
    serverProcess.kill('SIGTERM')
  }
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
