#!/usr/bin/env bun
import { REST, Routes, SlashCommandBuilder } from 'discord.js'
import { getDatabase } from '../src/discordBot'
import { intro, outro, spinner, cancel } from '@clack/prompts'

async function main() {
  console.log()
  intro('🤖 Discord Command Registration')

  const db = getDatabase()
  
  // Get saved credentials from database
  const existingBot = db
    .prepare('SELECT app_id, token FROM bot_tokens ORDER BY created_at DESC LIMIT 1')
    .get() as { app_id: string; token: string } | undefined

  if (!existingBot) {
    cancel('No bot credentials found. Please run the main CLI first to set up your bot.')
    process.exit(1)
  }

  const { app_id: appId, token } = existingBot
  console.log(`\nUsing bot with App ID: ${appId}`)

  const s = spinner()
  s.start('Registering slash commands...')

  const commands = [
    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('Resume an existing OpenCode session')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('The session to resume')
          .setRequired(true)
          .setAutocomplete(true)),
  ].map(command => command.toJSON())

  const rest = new REST().setToken(token)

  try {
    // Register commands globally
    const data = await rest.put(
      Routes.applicationCommands(appId),
      { body: commands },
    ) as any[]

    s.stop(`✅ Successfully registered ${data.length} global command(s)`)
    
    console.log('\nRegistered commands:')
    for (const cmd of data) {
      console.log(`  - /${cmd.name}: ${cmd.description}`)
    }
    
    console.log('\n📝 Note: Global commands can take up to an hour to propagate.')
    console.log('For instant updates during development, consider using guild-specific commands.')
    
    outro('✨ Command registration complete!')
  } catch (error) {
    s.stop('❌ Failed to register commands')
    console.error('\nError:', error instanceof Error ? error.message : String(error))
    
    if (error instanceof Error && error.message.includes('401')) {
      console.error('\nInvalid bot token. Please run the main CLI again to update your credentials.')
    }
    
    process.exit(1)
  } finally {
    db.close()
  }
}

main().catch(console.error)