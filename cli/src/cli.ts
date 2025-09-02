import { cac } from 'cac'
import dedent from 'string-dedent'
// @ts-expect-error still not typed https://github.com/ircam-ismm/node-web-audio-api/issues/73
import { mediaDevices } from 'node-web-audio-api'
import { MediaResolution, Modality } from '@google/genai'
import * as webAudioApi from 'node-web-audio-api'
import pc from 'picocolors'
import { getTools } from './tools'

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
                'liveapi/src/index'
            )

            let liveApiClient: InstanceType<typeof LiveAPIClient> | null = null

            const tools = await getTools({
                onMessageCompleted: (params) => {
                    if (!liveApiClient) return

                    const text = params.data
                        ? `<systemMessage>\nChat message completed for session ${params.sessionId}.\n\nAssistant response:\n${params.markdown}\n</systemMessage>`
                        : `<systemMessage>\nChat message failed for session ${params.sessionId}. Error: ${params.error?.message || 'Unknown error'}\n</systemMessage>`

                    liveApiClient.sendText(text)
                },
            })

            const newClient = new LiveAPIClient({
                apiKey: token!,
                model: 'models/gemini-2.5-flash-preview-native-audio-dialog',
                config: {
                    tools: callableToolsFromObject(tools),
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: 'Sadachbia',
                            },
                        },
                    },
                    mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,

                    contextWindowCompression: {
                        triggerTokens: '25600',
                        slidingWindow: { targetTokens: '12800' },
                    },
                    systemInstruction: {
                        parts: [
                            {
                                text: dedent`
                                You are Kimaki, an AI similar to Jarvis: you help your user (an engineer) controlling his coding agent, just like Jarvis controls Ironman armor and machines. Speak fast.

                                You should talk like Jarvis, British accent, satirical, joking and calm. Be short and concise and never ask for confirmation of what to do. Speak fast.

                                After tool calls give a super short summary of the action just accomplished.

                                When the user requests something you do it right away, NEVER tell "ok, doing it now" or let the user wait. JUST call the tool right away.

                                Before tool calls NEVER ask for confirmation, NEVER repeat the whole tool call parameters.

                                Your job is to manage many opencode agent chat instances. Opencode is the agent used to write the code, it is similar to Claude Code.

                                For everything the user asks it is implicit that the user is asking for you to proxy the requests to opencode sessions.

                                You can
                                - start new chats on a given project
                                - read the chats to report progress to the user
                                - submit messages to the chat
                                - list files for a given projects, so you can translate imprecise user prompts to precise messages that mention filename paths using @

                                Common patterns
                                - to get the last session use the listChats tool

                                Rules
                                - never spell files by mentioning dots, letters, etc. instead give a brief description of the filename
                                - never read session ids or other ids

                                You

                                `,
                            },
                        ],
                    },
                },
                onStateChange: (state) => {},
            })

            liveApiClient = newClient

            // Connect to the API
            const connected = await newClient.connect()
        } catch (error) {
            console.error(pc.red('\nError initializing project:'))
            console.error(pc.red(error))
            process.exit(1)
        }
    },
)
