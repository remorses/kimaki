import { startGenAiSession } from '../src/genai'

async function test() {
  console.log('Starting GenAI session test...')
  
  const session = await startGenAiSession({})

  console.log('Session started. Audio will be saved to audio.wav')
  console.log('Press Ctrl+C to stop.')

  process.on('SIGINT', () => {
    console.log('\nStopping session...')
    session.stop()
    process.exit(0)
  })
}

test().catch(console.error)