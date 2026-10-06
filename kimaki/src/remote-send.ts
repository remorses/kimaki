// Remote sends: `kimaki send` to a channel owned by another Kimaki bot process.
// The sender posts an envelope message as the bot user; the owning bot runs it
// (ingress.ts handleRemoteEnvelope) and replies with the result.
//
//   sender ──envelope: prompt + embed footer "kimaki-send-v2:{requestId, options}"──▶ channel
//   owner  ──reply:    embed footer "kimaki-result-v2:<requestId>:{threadId, sessionId}"──▶ channel
//
// Two senders: a running bot whose project list lacks the channel (prompt.ts),
// and the CLI when no local bot runs, e.g. CI with only KIMAKI_BOT_TOKEN
// (sendWithoutBot). Light imports only: the CLI loads this file.

import crypto from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import type { API } from '@discordjs/core/http-only'
import * as errore from 'errore'

import { ConfigError, DiscordError } from './errors.ts'
import type { SendInput } from './lock-routes.ts'

export const REMOTE_SEND_PREFIX = 'kimaki-send-v2:'
export const REMOTE_PROMPT_FILE = 'kimaki-prompt.md'
export const REMOTE_RESULT_PREFIX = 'kimaki-result-v2:'
export const REMOTE_TIMEOUT_MS = 20_000

export type RemoteResult = { threadId: string; sessionId: string | null }

// A PromptFile URI as a local path.
export function promptFilePath(file: { uri: string }): string {
  return file.uri.startsWith('file:') ? fileURLToPath(file.uri) : file.uri
}

// The envelope message of one remote send. An attachment is a Buffer or a local
// file path; the prompt file goes first, because the receiver reads the first attachment.
export function remoteEnvelope(input: SendInput) {
  const requestId = crypto.randomBytes(8).toString('hex')
  const { files, prompt, ...options } = input
  // A prompt over the message limit travels as an attachment; the content keeps a preview.
  const long = prompt.length > 2000
  const footer = `${REMOTE_SEND_PREFIX}${JSON.stringify({ requestId, options, ...(long && { promptFile: REMOTE_PROMPT_FILE }) })}`
  if (footer.length > 2048) return new ConfigError({ reason: 'Remote send options exceed the Discord embed limit. Send fewer options.' })
  const attachments: Array<{ name: string; attachment: Buffer | string }> = [
    ...(long ? [{ name: REMOTE_PROMPT_FILE, attachment: Buffer.from(prompt) }] : []),
    ...(files ?? []).map((file) => ({ name: file.name, attachment: promptFilePath(file) })),
  ]
  return { requestId, content: long ? `${prompt.slice(0, 1990)}…` : prompt, footer, attachments }
}

// null: not the answer to this request. Error: the owning bot reported a failure.
export function parseRemoteResult({ footer, requestId }: { footer: string | undefined; requestId: string }): ConfigError | RemoteResult | null {
  const prefix = `${REMOTE_RESULT_PREFIX}${requestId}:`
  if (!footer?.startsWith(prefix)) return null
  const parsed = errore.try(
    () => ({ value: JSON.parse(footer.slice(prefix.length)) as unknown }),
    (cause) => new ConfigError({ reason: 'Invalid remote response', cause }),
  )
  if (parsed instanceof Error) return parsed
  const result = parsed.value
  if (!result || typeof result !== 'object') return new ConfigError({ reason: 'Remote send failed' })
  const threadId = 'threadId' in result && typeof result.threadId === 'string' ? result.threadId : null
  const sessionId = 'sessionId' in result && (typeof result.sessionId === 'string' || result.sessionId === null) ? result.sessionId : undefined
  if (threadId && sessionId !== undefined) return { threadId, sessionId }
  return new ConfigError({ reason: 'error' in result && typeof result.error === 'string' ? result.error : 'Remote send failed' })
}

export function noAnswerError(): ConfigError {
  return new ConfigError({ reason: 'No Kimaki bot answered this send. Start Kimaki on the machine that owns this channel.' })
}

// `kimaki send` without a local bot: post the envelope over Discord REST with the
// bot token and poll the channel for the owning bot's reply.
export async function sendWithoutBot({ api, input }: { api: API; input: SendInput }): Promise<ConfigError | DiscordError | RemoteResult> {
  const channelId = input.threadId ?? input.channelId
  if (!channelId || input.sessionId || input.project) {
    return new ConfigError({ reason: 'Kimaki bot is not running here. Without a local bot, send needs --channel or --thread (a Discord ID), not --session or --project.' })
  }
  const envelope = remoteEnvelope(input)
  if (envelope instanceof Error) return envelope
  const files = await Promise.all(
    envelope.attachments.map(async (file) => ({ name: file.name, data: typeof file.attachment === 'string' ? await fs.promises.readFile(file.attachment) : file.attachment })),
  ).catch((cause) => new ConfigError({ reason: 'Cannot read a --file attachment', cause }))
  if (files instanceof Error) return files
  const posted = await api.channels
    .createMessage(channelId, { content: envelope.content, embeds: [{ footer: { text: envelope.footer } }], files, allowed_mentions: { parse: [] } })
    .catch((cause) => new DiscordError({ operation: 'send remote envelope', cause }))
  if (posted instanceof Error) return posted
  const deadline = Date.now() + REMOTE_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(1_000)
    const replies = await api.channels
      .getMessages(channelId, { after: posted.id, limit: 50 })
      .catch((cause) => new DiscordError({ operation: 'read remote reply', cause }))
    if (replies instanceof Error) return replies
    for (const reply of replies) {
      if (reply.author.id !== posted.author.id) continue
      const result = parseRemoteResult({ footer: reply.embeds[0]?.footer?.text, requestId: envelope.requestId })
      if (result) return result
    }
  }
  return noAnswerError()
}
