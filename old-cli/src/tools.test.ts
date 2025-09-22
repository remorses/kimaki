import { describe, test, expect } from 'vitest'
import { getTools } from './tools'

describe('tools', () => {
  test('listChats returns sessions sorted by most recent', async () => {
    const { tools } = await getTools({})

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
    const { tools } = await getTools({})

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

  test('getModels returns available models from all providers', async () => {
    const { tools } = await getTools({})

    const result = await tools.getModels.execute!({}, {} as any)

    expect(result).toMatchInlineSnapshot(`
      {
        "models": [
          {
            "modelId": "gpt-5-nano",
            "providerId": "openai",
          },
          {
            "modelId": "o3-pro",
            "providerId": "openai",
          },
          {
            "modelId": "codex-mini-latest",
            "providerId": "openai",
          },
          {
            "modelId": "gpt-4.1",
            "providerId": "openai",
          },
          {
            "modelId": "gpt-4-turbo",
            "providerId": "openai",
          },
          {
            "modelId": "o1",
            "providerId": "openai",
          },
          {
            "modelId": "o3-deep-research",
            "providerId": "openai",
          },
          {
            "modelId": "gpt-5",
            "providerId": "openai",
          },
          {
            "modelId": "o1-pro",
            "providerId": "openai",
          },
          {
            "modelId": "o3",
            "providerId": "openai",
          },
          {
            "modelId": "gpt-5-mini",
            "providerId": "openai",
          },
          {
            "modelId": "o1-preview",
            "providerId": "openai",
          },
          {
            "modelId": "o4-mini-deep-research",
            "providerId": "openai",
          },
          {
            "modelId": "gpt-4o-mini",
            "providerId": "openai",
          },
          {
            "modelId": "gpt-4.1-nano",
            "providerId": "openai",
          },
          {
            "modelId": "gpt-4.1-mini",
            "providerId": "openai",
          },
          {
            "modelId": "o1-mini",
            "providerId": "openai",
          },
          {
            "modelId": "gpt-4o",
            "providerId": "openai",
          },
          {
            "modelId": "gpt-4",
            "providerId": "openai",
          },
          {
            "modelId": "gpt-3.5-turbo",
            "providerId": "openai",
          },
          {
            "modelId": "o4-mini",
            "providerId": "openai",
          },
          {
            "modelId": "o3-mini",
            "providerId": "openai",
          },
          {
            "modelId": "llama-3.1-8b-instant",
            "providerId": "groq",
          },
          {
            "modelId": "qwen-qwq-32b",
            "providerId": "groq",
          },
          {
            "modelId": "llama3-70b-8192",
            "providerId": "groq",
          },
          {
            "modelId": "deepseek-r1-distill-llama-70b",
            "providerId": "groq",
          },
          {
            "modelId": "llama3-8b-8192",
            "providerId": "groq",
          },
          {
            "modelId": "gemma2-9b-it",
            "providerId": "groq",
          },
          {
            "modelId": "llama-3.3-70b-versatile",
            "providerId": "groq",
          },
          {
            "modelId": "mistral-saba-24b",
            "providerId": "groq",
          },
          {
            "modelId": "llama-guard-3-8b",
            "providerId": "groq",
          },
          {
            "modelId": "openai/gpt-oss-20b",
            "providerId": "groq",
          },
          {
            "modelId": "openai/gpt-oss-120b",
            "providerId": "groq",
          },
          {
            "modelId": "meta-llama/llama-guard-4-12b",
            "providerId": "groq",
          },
          {
            "modelId": "meta-llama/llama-4-maverick-17b-128e-instruct",
            "providerId": "groq",
          },
          {
            "modelId": "meta-llama/llama-4-scout-17b-16e-instruct",
            "providerId": "groq",
          },
          {
            "modelId": "qwen/qwen3-32b",
            "providerId": "groq",
          },
          {
            "modelId": "moonshotai/kimi-k2-instruct",
            "providerId": "groq",
          },
          {
            "modelId": "grok-code",
            "providerId": "opencode",
          },
          {
            "modelId": "qwen/qwen3-coder",
            "providerId": "opencode",
          },
          {
            "modelId": "claude-3-7-sonnet-20250219",
            "providerId": "anthropic",
          },
          {
            "modelId": "claude-opus-4-1-20250805",
            "providerId": "anthropic",
          },
          {
            "modelId": "claude-3-haiku-20240307",
            "providerId": "anthropic",
          },
          {
            "modelId": "claude-3-5-haiku-20241022",
            "providerId": "anthropic",
          },
          {
            "modelId": "claude-opus-4-20250514",
            "providerId": "anthropic",
          },
          {
            "modelId": "claude-3-5-sonnet-20241022",
            "providerId": "anthropic",
          },
          {
            "modelId": "claude-3-5-sonnet-20240620",
            "providerId": "anthropic",
          },
          {
            "modelId": "claude-3-sonnet-20240229",
            "providerId": "anthropic",
          },
          {
            "modelId": "claude-sonnet-4-20250514",
            "providerId": "anthropic",
          },
          {
            "modelId": "claude-3-opus-20240229",
            "providerId": "anthropic",
          },
        ],
        "success": true,
        "totalCount": 50,
      }
    `)
  })

})
