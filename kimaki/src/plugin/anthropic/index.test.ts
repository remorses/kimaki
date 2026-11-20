import { gunzipSync, gzipSync, zstdCompressSync } from 'node:zlib'
import { expect, test } from 'vitest'
import { prepareSubscriptionRequest, rewriteSystem } from './index.ts'

// Regression: OpenCode's exact <env> block made Anthropic bill subscription requests as third-party usage.
test('subscription rewrite adds the identity first and re-wraps the OpenCode env block once', () => {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-5',
    system: [
      { type: 'text', text: 'You are an AI agent running in OpenCode.' },
      { type: 'text', text: 'Here is some useful information about the environment you are running in:\n<env>\n  Working directory: /repo\n  Is directory a git repo: yes\n</env>\nmore', cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  })
  const payload = JSON.parse(body)
  expect(rewriteSystem(payload)).toBe(true)
  expect(payload.system).toMatchInlineSnapshot(`
    [
      {
        "text": "You are Claude Code, Anthropic's official CLI for Claude.",
        "type": "text",
      },
      {
        "text": "You are an AI agent running in OpenCode.",
        "type": "text",
      },
      {
        "cache_control": {
          "type": "ephemeral",
        },
        "text": "<environment>
      Working directory: /repo
      Is directory a git repo: yes
    </environment>
    more",
        "type": "text",
      },
    ]
  `)
  expect(rewriteSystem(payload)).toBe(false)
})

test('subscription requests to api.anthropic.com are gzipped, also when OpenCode gzipped them already', async () => {
  const json = JSON.stringify({ model: 'claude-sonnet-4-5', system: 'You are an AI agent running in OpenCode.', messages: [] })
  const send = ({ url = 'https://api.anthropic.com/v1/messages', headers = {}, body = json }: { url?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {}) =>
    prepareSubscriptionRequest({ request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1', ...headers }, body }) })
  const describe = async (request: Request | null) => {
    if (!request) return null
    const bytes = Buffer.from(await request.arrayBuffer())
    const encoding = request.headers.get('content-encoding')
    const text = (encoding === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8')
    return { encoding, length: request.headers.get('content-length'), system: JSON.parse(text).system.map((block: { text: string }) => block.text) }
  }

  expect(await describe(await send())).toMatchInlineSnapshot(`
    {
      "encoding": "gzip",
      "length": null,
      "system": [
        "You are Claude Code, Anthropic's official CLI for Claude.",
        "You are an AI agent running in OpenCode.",
      ],
    }
  `)
  // A body that needs no rewrite still gets compressed.
  const rewritten = JSON.parse(json)
  rewriteSystem(rewritten)
  expect(await describe(await send({ body: JSON.stringify(rewritten) }))).toMatchInlineSnapshot(`
    {
      "encoding": "gzip",
      "length": null,
      "system": [
        "You are Claude Code, Anthropic's official CLI for Claude.",
        "You are an AI agent running in OpenCode.",
      ],
    }
  `)
  // OpenCode compressed it (provider `encoding: "gzip"`): decoded, rewritten, compressed again.
  expect(await describe(await send({ headers: { 'content-encoding': 'gzip' }, body: new Uint8Array(gzipSync(json)) }))).toMatchInlineSnapshot(`
    {
      "encoding": "gzip",
      "length": null,
      "system": [
        "You are Claude Code, Anthropic's official CLI for Claude.",
        "You are an AI agent running in OpenCode.",
      ],
    }
  `)
  // A proxy base URL keeps plain JSON; other paths are left alone.
  expect(await describe(await send({ url: 'https://proxy.example.com/v1/messages' }))).toMatchInlineSnapshot(`
    {
      "encoding": null,
      "length": null,
      "system": [
        "You are Claude Code, Anthropic's official CLI for Claude.",
        "You are an AI agent running in OpenCode.",
      ],
    }
  `)
  // Anthropic rejects zstd (`encoding: "zstd"` in OpenCode), so it is sent as gzip; a proxy keeps it.
  expect((await describe(await send({ headers: { 'content-encoding': 'zstd' }, body: new Uint8Array(zstdCompressSync(json)) })))?.encoding).toBe('gzip')
  expect(await send({ url: 'https://proxy.example.com/v1/messages', headers: { 'content-encoding': 'zstd' }, body: new Uint8Array(zstdCompressSync(json)) })).toBe(null)
  expect(await send({ url: 'https://api.anthropic.com/v1/messages/count_tokens' })).toBe(null)
})
