import { cac } from 'cac'
// @ts-expect-error still not typed https://github.com/ircam-ismm/node-web-audio-api/issues/73
import { mediaDevices } from 'node-web-audio-api'
import { Modality } from '@google/genai'
import * as webAudioApi from 'node-web-audio-api'
import pc from 'picocolors'

export const cli = cac('kimaki')

cli.help()

// Check if running in TTY environment
const isTTY = process.stdout.isTTY && process.stdin.isTTY

cli.command('', 'Spawn Kimaki to orchestrate code agents')
    .action(async (options) => {
        try {
            const token = process.env.TOKEN

            Object.assign(globalThis, webAudioApi)
            // @ts-expect-error still not typed https://github.com/ircam-ismm/node-web-audio-api/issues/73
            navigator.mediaDevices = mediaDevices

            const { LiveAPIClient } = await import('liveapi/src')
            const newClient = new LiveAPIClient({
                apiKey: token!,
                config: {
                    responseModalities: [Modality.AUDIO],
                    // tools: callableTools,
                },
            })

            // Connect to the API
            const connected = await newClient.connect()
        } catch (error) {
            console.error(pc.red('\nError initializing project:'))
            console.error(pc.red(error))
            process.exit(1)
        }
    })
