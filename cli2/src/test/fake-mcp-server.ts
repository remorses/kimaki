// A minimal MCP server over stdio (newline-delimited JSON-RPC) with one
// prompt, for the /<prompt>-mcp-prompt e2e test. OpenCode starts it with
// `node fake-mcp-server.ts` from the test config.

import readline from 'node:readline'

type Request = { id?: number | string; method: string; params?: { protocolVersion?: string; arguments?: Record<string, string> } }

function send(message: object) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function result(request: Request) {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { prompts: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      }
    case 'prompts/list':
      return { prompts: [{ name: 'greet', description: 'Greet someone', arguments: [{ name: 'name', required: false }] }] }
    case 'prompts/get':
      return {
        messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${request.params?.arguments?.['name'] ?? 'nobody'} mcp-marker` } }],
      }
    case 'tools/list':
      return { tools: [] }
    case 'resources/list':
      return { resources: [] }
    case 'resources/templates/list':
      return { resourceTemplates: [] }
    case 'ping':
      return {}
    default:
      return null
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line) as Request
  if (request.id === undefined) return
  const value = result(request)
  if (value === null) {
    send({ id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } })
    return
  }
  send({ id: request.id, result: value })
})
