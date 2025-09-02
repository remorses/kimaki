import { cac } from 'cac'
import dedent from 'string-dedent'
import { tool } from 'ai'
import { z } from 'zod'
// @ts-expect-error still not typed https://github.com/ircam-ismm/node-web-audio-api/issues/73
import { mediaDevices } from 'node-web-audio-api'
import { Modality } from '@google/genai'
import * as webAudioApi from 'node-web-audio-api'
import pc from 'picocolors'

const tools = {
    startChat: tool({
        description: '',
        inputSchema: z.object({
            chatId: z.string(),
        }),
        execute: async ({ chatId }) => {},
    }),
}

export const cli = cac('kimaki')

cli.help()

// Check if running in TTY environment
const isTTY = process.stdout.isTTY && process.stdin.isTTY

cli.command('', 'Spawn Kimaki to orchestrate code agents').action(
    async (options) => {
        try {
            const token = process.env.TOKEN

            Object.assign(globalThis, webAudioApi)
            // @ts-expect-error still not typed https://github.com/ircam-ismm/node-web-audio-api/issues/73
            navigator.mediaDevices = mediaDevices

            const { LiveAPIClient, callableToolsFromObject } = await import(
                'liveapi/src'
            )

            const newClient = new LiveAPIClient({
                apiKey: token!,
                config: {
                    tools: callableToolsFromObject(tools),
                    responseModalities: [Modality.AUDIO],
                    systemInstruction: {
                        parts: [
                            {
                                text: dedent`

                                You are Kimaki, an AI similar to Jarvis: you help your user (an engineer) controlling his coding agent, just like Jarvis controls Ironman armor and machines.

                                Your job is to manage many opencode agent chat instances. Opencode is the agent used to write the code, it is similar to Claude Code.

                                You can
                                - start new chats on a given project
                                - read the chats to report progress to the user
                                - submit messages to the chat
                                - list files for a given projects, so you can translate imprecise user prompts to precise messages that mention filename paths using @
                                `,
                            },
                        ],
                    },
                },
                onStateChange: (state) => {},
            })

            // Connect to the API
            const connected = await newClient.connect()
        } catch (error) {
            console.error(pc.red('\nError initializing project:'))
            console.error(pc.red(error))
            process.exit(1)
        }
    },
)
