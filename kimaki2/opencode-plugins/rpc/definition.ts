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
  },
  events: {},
})
