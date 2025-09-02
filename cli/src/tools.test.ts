import { describe, test, expect } from 'vitest'
import { createTools, getOpenPort, startOpencodeServer } from './tools'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { ShareMarkdown } from './markdown'


describe('tools', () => {
    test('listChats returns sessions sorted by most recent', async () => {
        const port = await getOpenPort()
        const serverProcess = await startOpencodeServer(port)

        try {

            const client = createOpencodeClient({ baseUrl: `http://localhost:${port}` })
            const markdownRenderer = new ShareMarkdown(client)
            const tools = createTools(client, markdownRenderer)

            const result = await tools.listChats.execute!(
                {},
                {} as any,
            )

            expect(result).toMatchInlineSnapshot(`
              {
                "sessions": [
                  {
                    "finishedAt": "1 minute ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                    "id": "ses_6f520789cffeO68Ahg4ySbs1Vf",
                    "prompt": "Model Check",
                    "status": "finished",
                    "title": "Model Check",
                  },
                  {
                    "finishedAt": "3 minutes ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                    "id": "ses_6f522d8cbffejRVbQPgZiawsyx",
                    "prompt": "Model Check",
                    "status": "finished",
                    "title": "Model Check",
                  },
                  {
                    "finishedAt": "4 minutes ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                    "id": "ses_6f52376e7ffeMGqrFl8nGHYMzU",
                    "prompt": "Model Check",
                    "status": "finished",
                    "title": "Model Check",
                  },
                  {
                    "finishedAt": "6 minutes ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                    "id": "ses_6f5252e8bffeE9fV440Xkc6eOq",
                    "prompt": "Model Check",
                    "status": "finished",
                    "title": "Model Check",
                  },
                  {
                    "finishedAt": "6 minutes ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                    "id": "ses_6f5255699ffeohcbMIwO1dKwgS",
                    "prompt": "Model Check",
                    "status": "finished",
                    "title": "Model Check",
                  },
                  {
                    "finishedAt": "9 minutes ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                    "id": "ses_6f5279effffeNFmmgGqoMoGWHZ",
                    "prompt": "Test Chat",
                    "status": "finished",
                    "title": "Test Chat",
                  },
                  {
                    "finishedAt": "9 minutes ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                    "id": "ses_6f527f6aeffekwdhvLo3i8nsjH",
                    "prompt": "Test Chat",
                    "status": "finished",
                    "title": "Test Chat",
                  },
                  {
                    "finishedAt": "10 minutes ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                    "id": "ses_6f528838affeN4cGgIkaPF73Kv",
                    "prompt": "Test Chat",
                    "status": "finished",
                    "title": "Test Chat",
                  },
                  {
                    "finishedAt": "22 minutes ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                    "id": "ses_6f5762420ffeYGuWsJRGUasvka",
                    "prompt": "Documenting OpenCode SDK capabilities and types",
                    "status": "finished",
                    "title": "Documenting OpenCode SDK capabilities and types",
                  },
                  {
                    "finishedAt": "about 1 hour ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                    "id": "ses_6f56ef1b8ffeooW5Z863oDw269",
                    "prompt": "Implementing OpenCode SDK CLI tools",
                    "status": "finished",
                    "title": "Implementing OpenCode SDK CLI tools",
                  },
                  {
                    "finishedAt": "about 2 hours ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                    "id": "ses_6f5ba2346ffeapfx7cVJHnNU2l",
                    "prompt": "Testing ShareMarkdown markdown generation logic",
                    "status": "finished",
                    "title": "Testing ShareMarkdown markdown generation logic",
                  },
                  {
                    "finishedAt": "about 3 hours ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                    "id": "ses_6f5dbf892ffejdkTeb9nW4a5Hj",
                    "prompt": "Exploring OpenCode and Plugin SDK Events",
                    "status": "finished",
                    "title": "Exploring OpenCode and Plugin SDK Events",
                  },
                  {
                    "finishedAt": "about 3 hours ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                    "id": "ses_6f5f9d8bbffe1x6odFw3BfKMpf",
                    "prompt": "Initializing Prisma SQLite with Chat model",
                    "status": "finished",
                    "title": "Initializing Prisma SQLite with Chat model",
                  },
                  {
                    "finishedAt": "about 4 hours ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                    "id": "ses_6f6038e3effeG5naJZCFaYy955",
                    "prompt": "Exploring Conversation Starter",
                    "status": "finished",
                    "title": "Exploring Conversation Starter",
                  },
                  {
                    "finishedAt": "about 4 hours ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                    "id": "ses_6f603fe2cffeRrC09A6wAMge1h",
                    "prompt": "New session - 2025-09-02T10:32:14.547Z",
                    "status": "finished",
                    "title": "New session - 2025-09-02T10:32:14.547Z",
                  },
                  {
                    "finishedAt": "about 4 hours ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                    "id": "ses_6f605ad1dffetDCy3KHZKwJQDn",
                    "prompt": "Bundling Bun plugin with build command",
                    "status": "finished",
                    "title": "Bundling Bun plugin with build command",
                  },
                  {
                    "finishedAt": "about 4 hours ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                    "id": "ses_6f60ab82bffeoCf19WnY0x1noL",
                    "prompt": "Implementing file logging mechanism",
                    "status": "finished",
                    "title": "Implementing file logging mechanism",
                  },
                  {
                    "finishedAt": "about 5 hours ago",
                    "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                    "id": "ses_6f633a680ffeUNdBhGIVyCAz0k",
                    "prompt": "New session - 2025-09-02T09:40:11.264Z",
                    "status": "finished",
                    "title": "New session - 2025-09-02T09:40:11.264Z",
                  },
                ],
                "success": true,
              }
            `)
        } finally {
            serverProcess.kill('SIGTERM')
        }
    })

    test('createNewChat creates session and sends initial message', async () => {
        const port = await getOpenPort()
        const serverProcess = await startOpencodeServer(port)

        try {

            const client = createOpencodeClient({ baseUrl: `http://localhost:${port}` })
            const markdownRenderer = new ShareMarkdown(client)
            const tools = createTools(client, markdownRenderer)

            const result = await tools.createNewChat.execute!(
                {
                    message: 'What model are you?',
                    title: 'Model Check',
                },
                {} as any,
            )

            expect(result).toMatchInlineSnapshot(`
              {
                "messageId": "pending",
                "sessionId": "ses_6f51fcc36ffexxphufZr1MuQzA",
                "success": true,
                "title": "Model Check",
              }
            `)
        } finally {
            serverProcess.kill('SIGTERM')
        }
    })
})
