#!/usr/bin/env node
import { intro, outro, text, password, note, cancel, isCancel } from '@clack/prompts'
import { generateBotInstallUrl } from './utils'

async function main() {
  console.log()
  intro('🤖 Discord Bot Setup')

  note(
    '1. Go to https://discord.com/developers/applications\n' +
    '2. Click "New Application"\n' +
    '3. Give your application a name\n' +
    '4. Copy the Application ID from the "General Information" section',
    'Step 1: Create Discord Application'
  )

  const appId = await text({
    message: 'Enter your Discord Application ID:',
    placeholder: 'e.g., 1234567890123456789',
    validate(value) {
      if (!value) return 'Application ID is required'
      if (!/^\d{17,20}$/.test(value)) return 'Invalid Application ID format (should be 17-20 digits)'
    },
  })

  if (isCancel(appId)) {
    cancel('Setup cancelled')
    process.exit(0)
  }

  note(
    '1. Go to the "Bot" section in the left sidebar\n' +
    '2. Click "Reset Token" to generate a new bot token\n' +
    '3. Copy the token (you won\'t be able to see it again!)',
    'Step 2: Get Bot Token'
  )

  const token = await password({
    message: 'Enter your Discord Bot Token (will be hidden):',
    validate(value) {
      if (!value) return 'Bot token is required'
      if (value.length < 50) return 'Invalid token format (too short)'
    },
  })

  if (isCancel(token)) {
    cancel('Setup cancelled')
    process.exit(0)
  }

  console.log()
  note(
    `Application ID: ${appId}\n` +
    `Token: ${token.slice(0, 20)}...${token.slice(-5)} (hidden)\n\n` +
    'Bot invite URL:\n' +
    generateBotInstallUrl({ clientId: appId }),
    'Bot Configuration'
  )

  outro('✅ Setup complete! You can now use these credentials to run your bot.')
}

main().catch(console.error)