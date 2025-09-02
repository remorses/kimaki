import { describe, test, expect } from 'vitest'
import { getTools } from './tools'

describe('tools', () => {
    test('listChats returns sessions sorted by most recent', async () => {
        const tools = await getTools({})

        const result = await tools.listChats.execute!({}, {} as any)

        expect(result).toMatchInlineSnapshot(`
          {
            "sessions": [
              {
                "finishedAt": "less than a minute ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f4c8500dffeuBTJUb7UPiCrjr",
                "prompt": "Model Check",
                "status": "finished",
                "title": "Model Check",
              },
              {
                "finishedAt": "4 minutes ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f50a015cffexCOVh3LnDPe6lS",
                "prompt": "Implementing onMessageSent callback and LiveAPI message sending",
                "status": "in_progress",
                "title": "Implementing onMessageSent callback and LiveAPI message sending",
              },
              {
                "finishedAt": "about 1 hour ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f50cb040ffeHAxHapvKNFNN5S",
                "prompt": "New session for testing callback.",
                "status": "finished",
                "title": "New session for testing callback.",
              },
              {
                "finishedAt": "about 1 hour ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f5138fbfffemrFpe4NqjhQ7eh",
                "prompt": "New session initiated.",
                "status": "finished",
                "title": "New session initiated.",
              },
              {
                "finishedAt": "about 1 hour ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f513e88cffe89t6rWqTIav5dm",
                "prompt": "Double check the last commit diff.",
                "status": "finished",
                "title": "Double check the last commit diff.",
              },
              {
                "finishedAt": "about 2 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f51fcc36ffexxphufZr1MuQzA",
                "prompt": "Model Check",
                "status": "finished",
                "title": "Model Check",
              },
              {
                "finishedAt": "about 2 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f520789cffeO68Ahg4ySbs1Vf",
                "prompt": "Model Check",
                "status": "finished",
                "title": "Model Check",
              },
              {
                "finishedAt": "about 2 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f522d8cbffejRVbQPgZiawsyx",
                "prompt": "Model Check",
                "status": "finished",
                "title": "Model Check",
              },
              {
                "finishedAt": "about 2 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f52376e7ffeMGqrFl8nGHYMzU",
                "prompt": "Model Check",
                "status": "finished",
                "title": "Model Check",
              },
              {
                "finishedAt": "about 2 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f5252e8bffeE9fV440Xkc6eOq",
                "prompt": "Model Check",
                "status": "finished",
                "title": "Model Check",
              },
              {
                "finishedAt": "about 2 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f5255699ffeohcbMIwO1dKwgS",
                "prompt": "Model Check",
                "status": "finished",
                "title": "Model Check",
              },
              {
                "finishedAt": "about 2 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f5279effffeNFmmgGqoMoGWHZ",
                "prompt": "Test Chat",
                "status": "finished",
                "title": "Test Chat",
              },
              {
                "finishedAt": "about 2 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f527f6aeffekwdhvLo3i8nsjH",
                "prompt": "Test Chat",
                "status": "finished",
                "title": "Test Chat",
              },
              {
                "finishedAt": "about 2 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f528838affeN4cGgIkaPF73Kv",
                "prompt": "Test Chat",
                "status": "finished",
                "title": "Test Chat",
              },
              {
                "finishedAt": "about 2 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                "id": "ses_6f5762420ffeYGuWsJRGUasvka",
                "prompt": "Documenting OpenCode SDK capabilities and types",
                "status": "finished",
                "title": "Documenting OpenCode SDK capabilities and types",
              },
              {
                "finishedAt": "about 3 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                "id": "ses_6f56ef1b8ffeooW5Z863oDw269",
                "prompt": "Implementing OpenCode SDK CLI tools",
                "status": "finished",
                "title": "Implementing OpenCode SDK CLI tools",
              },
              {
                "finishedAt": "about 4 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice/cli",
                "id": "ses_6f5ba2346ffeapfx7cVJHnNU2l",
                "prompt": "Testing ShareMarkdown markdown generation logic",
                "status": "finished",
                "title": "Testing ShareMarkdown markdown generation logic",
              },
              {
                "finishedAt": "about 5 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                "id": "ses_6f5dbf892ffejdkTeb9nW4a5Hj",
                "prompt": "Exploring OpenCode and Plugin SDK Events",
                "status": "finished",
                "title": "Exploring OpenCode and Plugin SDK Events",
              },
              {
                "finishedAt": "about 5 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                "id": "ses_6f5f9d8bbffe1x6odFw3BfKMpf",
                "prompt": "Initializing Prisma SQLite with Chat model",
                "status": "finished",
                "title": "Initializing Prisma SQLite with Chat model",
              },
              {
                "finishedAt": "about 6 hours ago",
                "folder": "/Users/morse/Documents/GitHub/kimakivoice",
                "id": "ses_6f6038e3effeG5naJZCFaYy955",
                "prompt": "Exploring Conversation Starter",
                "status": "finished",
                "title": "Exploring Conversation Starter",
              },
            ],
            "success": true,
          }
        `)
    })

    test('createNewChat creates session and sends initial message', async () => {
        const tools = await getTools({})

        const result = await tools.createNewChat.execute!(
            {
                message: 'What model are you?',
                title: 'Model Check',
            },
            {} as any,
        )

        expect(result).toMatchInlineSnapshot(`
          {
            "messageId": "jhUGOP2ciTAFCVgK",
            "sessionId": "ses_6f4c82bb6ffePj9YPVSleXVGZR",
            "success": true,
            "title": "Model Check",
          }
        `)
    })
})
