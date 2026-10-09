// `kimaki tts` speech generation against local OpenAI- and Gemini-compatible
// HTTP servers: the real requests and response parsing run, no network.

import http from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { freePort } from './test/harness.ts'
import { generateSpeech } from './voice.ts'

const requests: Array<{ url: string; headers: Record<string, string | undefined>; body: unknown }> = []
const pcm = Buffer.from([1, 2, 3, 4])
let server: http.Server
let baseUrl = ''

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      requests.push({ url: request.url ?? '', headers: { authorization: request.headers.authorization, key: request.headers['x-goog-api-key'] as string | undefined }, body })
      if (request.url?.endsWith('/audio/speech')) {
        response.setHeader('content-type', 'audio/mpeg')
        response.end(Buffer.from('mp3-bytes'))
        return
      }
      if (request.url?.includes('fail')) {
        response.statusCode = 400
        response.end('{"error":"bad voice"}')
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] }))
    })
  })
  const port = await freePort()
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test('OpenAI returns mp3; Gemini PCM is wrapped in a WAV header; HTTP errors are values', async () => {
  const openai = await generateSpeech({ text: 'Hello', provider: 'openai', apiKey: 'sk-test', speed: 1.25, instructions: 'Calm', baseUrls: { openai: baseUrl } })
  const gemini = await generateSpeech({ text: 'Ciao', provider: 'gemini', apiKey: 'gm-test', voice: 'Puck', baseUrls: { gemini: baseUrl } })
  const failed = await generateSpeech({ text: 'x', provider: 'gemini', apiKey: 'gm-test', baseUrls: { gemini: `${baseUrl}/fail` } })
  if (openai instanceof Error) throw openai
  if (gemini instanceof Error) throw gemini
  expect({
    openai: { mediaType: openai.mediaType, audio: openai.audio.toString() },
    gemini: { mediaType: gemini.mediaType, header: gemini.audio.subarray(0, 4).toString(), bytes: gemini.audio.length, rate: gemini.audio.readUInt32LE(24) },
    failed: failed instanceof Error ? failed.message : 'no error',
    requests,
  }).toMatchInlineSnapshot(`
    {
      "failed": "Speech generation failed: HTTP 400: {"error":"bad voice"}",
      "gemini": {
        "bytes": 48,
        "header": "RIFF",
        "mediaType": "audio/wav",
        "rate": 24000,
      },
      "openai": {
        "audio": "mp3-bytes",
        "mediaType": "audio/mp3",
      },
      "requests": [
        {
          "body": {
            "input": "Hello",
            "instructions": "Calm",
            "model": "gpt-4o-mini-tts",
            "response_format": "mp3",
            "speed": 1.25,
            "voice": "alloy",
          },
          "headers": {
            "authorization": "Bearer sk-test",
            "key": undefined,
          },
          "url": "/audio/speech",
        },
        {
          "body": {
            "contents": [
              {
                "parts": [
                  {
                    "text": "Ciao",
                  },
                ],
                "role": "user",
              },
            ],
            "generationConfig": {
              "responseModalities": [
                "AUDIO",
              ],
              "speechConfig": {
                "voiceConfig": {
                  "prebuiltVoiceConfig": {
                    "voiceName": "Puck",
                  },
                },
              },
            },
          },
          "headers": {
            "authorization": undefined,
            "key": "gm-test",
          },
          "url": "/models/gemini-2.5-flash-preview-tts:generateContent",
        },
        {
          "body": {
            "contents": [
              {
                "parts": [
                  {
                    "text": "x",
                  },
                ],
                "role": "user",
              },
            ],
            "generationConfig": {
              "responseModalities": [
                "AUDIO",
              ],
              "speechConfig": {
                "voiceConfig": {
                  "prebuiltVoiceConfig": {
                    "voiceName": "Kore",
                  },
                },
              },
            },
          },
          "headers": {
            "authorization": undefined,
            "key": "gm-test",
          },
          "url": "/fail/models/gemini-2.5-flash-preview-tts:generateContent",
        },
      ],
    }
  `)
})
