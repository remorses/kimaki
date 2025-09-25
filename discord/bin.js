#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const NODE_PATH = process.execPath
const CLI_PATH = join(__dirname, 'dist', 'cli.js')

let lastStart = 0

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run() {
  while (true) {
    const now = Date.now()
    const elapsed = now - lastStart
    if (elapsed < 5000) {
      await sleep(5000 - elapsed)
    }
    lastStart = Date.now()

    try {
      const code = await new Promise((resolve) => {
        const child = spawn(NODE_PATH, [CLI_PATH, ...process.argv.slice(2)], {
          stdio: 'inherit'
        })

        child.on('exit', (code, signal) => {
          if (signal) {
            // Map signals to exit codes similar to bash
            if (signal === 'SIGINT') resolve(130)
            else if (signal === 'SIGTERM') resolve(143)
            else resolve(1)
          } else {
            resolve(code || 0)
          }
        })

        child.on('error', (err) => {
          console.error('Failed to start process:', err)
          resolve(1)
        })
      })

      // Exit cleanly if the app ended OK or via SIGINT/SIGTERM
      if (code === 0 || code === 130 || code === 143 || code === 64) {
        process.exit(code)
      }
      // otherwise loop; the 5s throttle above will apply
    } catch (err) {
      console.error('Unexpected error:', err)
      // Continue looping after error
    }
  }
}

run().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})