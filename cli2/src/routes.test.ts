// Every text input shape and the Route it becomes (spec 9.4).

import { expect, test } from 'vitest'

import { parseTextMessage } from './routes.ts'

test('suffixes, shell and commands', () => {
  const inputs = [
    'fix the test',
    'fix the test. queue',
    'fix the test\nqueue',
    'queue',
    'what is this? btw',
    'what is this\nbtw',
    'what is this. btw queue',
    'btw fix this',
    'hello btw',
    '!pnpm test',
    '!',
    '/review the auth module',
    '/review. queue',
    '   ',
  ]
  expect(Object.fromEntries(inputs.map((content) => [content, parseTextMessage({ content })]))).toMatchInlineSnapshot(`
    {
      "   ": null,
      "!": null,
      "!pnpm test": {
        "command": "pnpm test",
        "kind": "shell",
      },
      "/review the auth module": {
        "arguments": "the auth module",
        "kind": "command",
        "name": "review",
        "queue": false,
      },
      "/review. queue": {
        "arguments": "",
        "kind": "command",
        "name": "review",
        "queue": true,
      },
      "btw fix this": {
        "kind": "steer",
        "text": "btw fix this",
      },
      "fix the test": {
        "kind": "steer",
        "text": "fix the test",
      },
      "fix the test
    queue": {
        "kind": "queue",
        "text": "fix the test",
      },
      "fix the test. queue": {
        "kind": "queue",
        "text": "fix the test",
      },
      "hello btw": {
        "kind": "steer",
        "text": "hello btw",
      },
      "queue": null,
      "what is this
    btw": {
        "kind": "btw",
        "text": "what is this",
      },
      "what is this. btw queue": {
        "kind": "btw",
        "text": "what is this",
      },
      "what is this? btw": {
        "kind": "btw",
        "text": "what is this",
      },
    }
  `)
})
