import { createDiscordClient, startDiscordBot } from '../src/discord-bot'

async function test() {
  console.log('Starting Discord bot with voice and GenAI integration test...')

  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN environment variable is required')
  }

  const discordClient = await createDiscordClient()

  discordClient.once('ready', () => {
    console.log('Bot is ready! Join a voice channel as an admin to test.')
    console.log('The bot will:')
    console.log('1. Join your voice channel automatically')
    console.log('2. Listen to your voice input')
    console.log('3. Respond with AI-generated voice')
  })

  await startDiscordBot({ token, discordClient })
}

test().catch(console.error)
