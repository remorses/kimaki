import { Modality } from '@google/genai'
import * as webAudioApi from 'node-web-audio-api'
// @ts-expect-error still not typed https://github.com/ircam-ismm/node-web-audio-api/issues/73
import { mediaDevices } from 'node-web-audio-api'

async function main() {
  const token = process.env.TOKEN

  Object.assign(globalThis, webAudioApi)
  // @ts-expect-error still not typed https://github.com/ircam-ismm/node-web-audio-api/issues/73
  navigator.mediaDevices = mediaDevices

  const { LiveAPIClient } = await import('./live-api-client.ts')
  const newClient = new LiveAPIClient({
    apiKey: token!,
    config: {
      responseModalities: [Modality.AUDIO],
      // tools: callableTools,
    },
  })

  // Connect to the API
  const connected = await newClient.connect()
}

main()
