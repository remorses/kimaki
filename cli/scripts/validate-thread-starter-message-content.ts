#!/usr/bin/env tsx
// Probe Discord Message Content Intent behavior for thread starter messages.
// Run with Message Content Intent disabled, mention the bot inside a thread,
// and compare the visible reply content with fetched starter message content.

import * as discord from 'discord.js'

const { Client, GatewayIntentBits } = discord

const token = process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN

if (!token) {
  console.error('Set DISCORD_BOT_TOKEN or BOT_TOKEN before running this script.')
  process.exit(1)
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
})

function summarizeMessage(message: discord.Message) {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    content: message.content,
    contentLength: message.content.length,
    attachments: message.attachments.size,
    embeds: message.embeds.length,
    components: message.components.length,
  }
}

function formatSummary(label: string, result: Error | discord.Message) {
  if (result instanceof Error) return `${label}: ${result.message}`

  return [
    `${label}:`,
    `id=${result.id}`,
    `channel=${result.channelId}`,
    `contentLength=${result.content.length}`,
    `content=${JSON.stringify(result.content)}`,
    `attachments=${result.attachments.size}`,
    `embeds=${result.embeds.length}`,
    `components=${result.components.length}`,
  ].join('\n')
}

async function fetchThreadStarter(channel: discord.ThreadChannel) {
  const starter = await channel
    .fetchStarterMessage()
    .catch((cause) => new Error('fetchStarterMessage failed', { cause }))
  if (starter instanceof Error) return starter
  if (!starter) return new Error('Thread has no starter message')
  return starter
}

async function fetchParentMessageByThreadId(channel: discord.ThreadChannel) {
  const parent = channel.parent
  if (!parent || !parent.isTextBased()) {
    return new Error('Thread parent is missing or not text based')
  }

  const message = await parent.messages
    .fetch(channel.id)
    .catch((cause) => new Error('parent.messages.fetch(thread.id) failed', { cause }))
  return message
}

async function fetchReferencedMessage(message: discord.Message) {
  if (!message.reference?.messageId) {
    return new Error('Message has no reply reference')
  }

  const channel = await client.channels
    .fetch(message.reference.channelId || message.channelId)
    .catch((cause) => new Error('Failed to fetch referenced channel', { cause }))
  if (channel instanceof Error) return channel
  if (!channel || !channel.isTextBased()) {
    return new Error('Referenced channel is missing or not text based')
  }

  const referenced = await channel.messages
    .fetch(message.reference.messageId)
    .catch((cause) => new Error('Failed to fetch referenced message', { cause }))
  return referenced
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user?.tag}`)
  console.log('MessageContent intent is intentionally NOT requested.')
  console.log('Now create a thread from a message, then mention this bot inside the thread.')
})

client.on('messageCreate', async (message) => {
  if (message.author.bot) return

  console.log('\nReceived message:')
  console.log(JSON.stringify(summarizeMessage(message), null, 2))

  const referenced = await fetchReferencedMessage(message)
  console.log(formatSummary('reply reference fetch result', referenced))

  if (!message.channel.isThread()) {
    console.log('Message is not in a thread, skipping starter fetch.')
    await message.reply(formatSummary('reply reference fetch result', referenced)).catch((cause) => {
      console.error(new Error('Failed to reply with probe result', { cause }).message)
    })
    return
  }

  console.log('Thread info:')
  console.log(
    JSON.stringify(
      {
        threadId: message.channel.id,
        threadName: message.channel.name,
        parentId: message.channel.parentId,
      },
      null,
      2,
    ),
  )

  const starter = await fetchThreadStarter(message.channel)
  if (starter instanceof Error) {
    console.log(starter.message)
  } else {
    console.log('fetchStarterMessage result:')
    console.log(JSON.stringify(summarizeMessage(starter), null, 2))
  }

  const parentMessage = await fetchParentMessageByThreadId(message.channel)
  if (parentMessage instanceof Error) console.log(parentMessage.message)

  if (!(parentMessage instanceof Error)) {
    console.log('parent.messages.fetch(thread.id) result:')
    console.log(JSON.stringify(summarizeMessage(parentMessage), null, 2))
  }

  const report = [
    'Message content probe result',
    formatSummary('received message', message),
    formatSummary('reply reference fetch result', referenced),
    formatSummary('fetchStarterMessage result', starter),
    formatSummary('parent.messages.fetch(thread.id) result', parentMessage),
  ].join('\n\n')

  await message.reply(report.slice(0, 1900)).catch((cause) => {
    console.error(new Error('Failed to reply with probe result', { cause }).message)
  })
})

const loginResult = await client
  .login(token)
  .catch((cause) => new Error('Discord login failed', { cause }))
if (loginResult instanceof Error) {
  console.error(loginResult.message)
  process.exit(1)
}
