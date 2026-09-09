// Kimaki RPC contract plus HTTP client helper. Plugin.define stays in opencode-plugins/rpc.

import { OpenCode } from '@opencode-ai/client'
import { Rpc } from '@opencode-ai/plugin'

export const Kimaki = Rpc.define({
  id: 'kimaki',
  methods: {
    send: {
      input: {
        type: 'object',
        properties: {
          channelID: { type: 'string' },
          prompt: { type: 'string' },
          userID: { type: 'string' },
        },
        required: ['channelID', 'prompt'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          threadID: { type: 'string' },
        },
        required: ['sessionID', 'threadID'],
        additionalProperties: false,
      },
      errors: {
        unknown_channel: {
          type: 'object',
          properties: { channelID: { type: 'string' } },
          required: ['channelID'],
          additionalProperties: false,
        },
      },
    },
    prompt: {
      input: {
        type: 'object',
        properties: {
          threadID: { type: 'string' },
          prompt: { type: 'string' },
          userID: { type: 'string' },
          delivery: { type: 'string', enum: ['steer', 'queue'] },
        },
        required: ['threadID', 'prompt'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          threadID: { type: 'string' },
        },
        required: ['sessionID', 'threadID'],
        additionalProperties: false,
      },
      errors: {
        unknown_thread: {
          type: 'object',
          properties: { threadID: { type: 'string' } },
          required: ['threadID'],
          additionalProperties: false,
        },
      },
    },
    abort: {
      input: {
        type: 'object',
        properties: {
          threadID: { type: 'string' },
        },
        required: ['threadID'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          sessionID: { type: 'string' },
        },
        required: ['ok', 'sessionID'],
        additionalProperties: false,
      },
      errors: {
        unknown_thread: {
          type: 'object',
          properties: { threadID: { type: 'string' } },
          required: ['threadID'],
          additionalProperties: false,
        },
      },
    },
  },
  events: {},
})

export function kimakiRpc({ url, password }: { url: string; password: string }) {
  const client = OpenCode.make({
    baseUrl: url,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
  })
  return client.rpc(Kimaki)
}
