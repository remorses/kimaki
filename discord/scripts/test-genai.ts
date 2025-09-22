import { createAudioResource, StreamType } from '@discordjs/voice';
import { startGenAiSession } from '../src/genai'

async function test() {
  console.log('Starting GenAI session test...')

  const { session, stop } = await startGenAiSession({
    onAssistantAudioChunk({ data }) {},
  })



  console.log('Session started. Audio will be saved to audio.wav')
  console.log('Press Ctrl+C to stop.')

  session.sendClientContent({ turns: ['tell me a story'], turnComplete: true })
  await new Promise((resolve) => setTimeout(resolve, 2 * 1000))

  session.sendClientContent({
    turns: ['what model are you?'],
    turnComplete: true,
  })


  process.on('SIGINT', () => {
    console.log('\nStopping session...')
    stop()
    process.exit(0)
  })
}

test().catch(console.error)
