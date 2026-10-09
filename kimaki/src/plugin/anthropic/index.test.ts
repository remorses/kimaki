import { expect, test } from 'vitest'
import { rewriteSubscriptionRequest } from './index.ts'

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
  const once = rewriteSubscriptionRequest(body)
  expect(once && JSON.parse(once).system).toMatchInlineSnapshot(`
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
  expect(rewriteSubscriptionRequest(once!)).toBe(null)
})
