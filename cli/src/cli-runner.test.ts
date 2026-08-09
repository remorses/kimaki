import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  getOpenUrlCommand,
  isTransientNetworkError,
  sendDiscordMessageWithOptionalAttachment,
  wrapPromptAttachmentText,
} from './cli-runner.js'

describe('getOpenUrlCommand', () => {
  const installUrl =
    'https://kimaki.dev/discord-install?clientId=abc&clientSecret=def'

  test('uses a shell-free opener on Windows', () => {
    expect(getOpenUrlCommand(installUrl, 'win32')).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', installUrl],
    })
  })

  test('uses open on macOS', () => {
    expect(getOpenUrlCommand(installUrl, 'darwin')).toEqual({
      command: 'open',
      args: [installUrl],
    })
  })

  test('uses xdg-open on Linux', () => {
    expect(getOpenUrlCommand(installUrl, 'linux')).toEqual({
      command: 'xdg-open',
      args: [installUrl],
    })
  })
})

describe('isTransientNetworkError', () => {
  test('treats TLS leaf verification failures as transient', () => {
    const error = Object.assign(
      new Error('unable to verify the first certificate'),
      {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      },
    )
    expect(isTransientNetworkError(error)).toBe(true)
  })

  test('matches TLS cert failures by message when code is missing', () => {
    expect(
      isTransientNetworkError(new Error('unable to verify the first certificate')),
    ).toBe(true)
  })

  test('walks cause chains for nested TLS errors', () => {
    const cause = Object.assign(
      new Error('unable to verify the first certificate'),
      {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      },
    )
    expect(
      isTransientNetworkError(new Error('Discord login failed', { cause })),
    ).toBe(true)
  })

  test('keeps fatal auth-style errors non-transient', () => {
    expect(
      isTransientNetworkError(new Error('An invalid token was provided.')),
    ).toBe(false)
    expect(isTransientNetworkError(new Error('Used disallowed intents'))).toBe(
      false,
    )
  })

  test('still treats classic socket codes as transient', () => {
    const error = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
      code: 'ENOTFOUND',
    })
    expect(isTransientNetworkError(error)).toBe(true)
  })
})

describe('wrapPromptAttachmentText', () => {
  test('soft-breaks long lines near column 120', () => {
    const long = 'word '.repeat(40).trim() + ' ' + 'end'
    const wrapped = wrapPromptAttachmentText(long)
    expect(wrapped.split('\n').every((line) => line.length <= 120)).toBe(true)
    expect(wrapped.replace(/\n/g, ' ')).toContain('end')
  })
})

describe('sendDiscordMessageWithOptionalAttachment', () => {
  const originalFetch = globalThis.fetch

  /** REST is only used on the short-prompt / split paths. */
  function unusedRest() {
    return {
      post: async () => {
        throw new Error('REST.post should not be called for attachment uploads')
      },
    }
  }

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function listKimakiPromptDirs() {
    return fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('kimaki-prompt-'))
  }

  function installFetch(
    handler: (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => ReturnType<typeof fetch>,
  ) {
    globalThis.fetch = Object.assign(handler, {
      preconnect: originalFetch.preconnect?.bind(originalFetch) ?? (() => {}),
    })
  }

  function mockFetchOk({ id }: { id: string }) {
    const requests: Array<{ url: string; body: FormData | null }> = []
    installFetch(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      const body = init?.body instanceof FormData ? init.body : null
      requests.push({ url, body })
      return new Response(JSON.stringify({ id }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    return requests
  }

  async function readFormDataFiles(body: FormData) {
    const files: Array<{ name: string; text: string }> = []
    for (let index = 0; ; index += 1) {
      const key = `files[${index}]`
      const value = body.get(key)
      if (value == null) break
      if (typeof value === 'string') {
        files.push({ name: key, text: value })
        continue
      }
      files.push({
        name: value.name || key,
        text: await value.text(),
      })
    }
    return files
  }

  test('attaches long prompts from memory without creating temp dirs', async () => {
    const before = new Set(listKimakiPromptDirs())
    const requests = mockFetchOk({ id: 'msg-long' })
    const prompt = `LONG_PROMPT_MARKER ${'x'.repeat(2100)}`

    const result = await sendDiscordMessageWithOptionalAttachment({
      channelId: '111',
      prompt,
      botToken: 'token',
      rest: unusedRest(),
    })

    expect(result).toEqual({ id: 'msg-long' })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toBeInstanceOf(FormData)

    const formData = requests[0]!.body!
    const payload = JSON.parse(String(formData.get('payload_json')))
    expect(payload.content).toContain('Prompt attached as file')
    expect(payload.attachments).toEqual([{ id: 0, filename: 'prompt.md' }])

    const files = await readFormDataFiles(formData)
    expect(files).toHaveLength(1)
    expect(files[0]!.text).toContain('LONG_PROMPT_MARKER')

    const created = listKimakiPromptDirs().filter((name) => !before.has(name))
    expect(created).toEqual([])
  })

  test('attaches long prompts alongside user files without temp prompt paths', async () => {
    const before = new Set(listKimakiPromptDirs())
    const requests = mockFetchOk({ id: 'msg-files' })
    const userFile = path.join(
      os.tmpdir(),
      `kimaki-send-user-file-${process.pid}-${Date.now()}.txt`,
    )
    fs.writeFileSync(userFile, 'user-file-body')
    const prompt = `LONG_WITH_FILE ${'y'.repeat(2100)}`

    try {
      const result = await sendDiscordMessageWithOptionalAttachment({
        channelId: '222',
        prompt,
        botToken: 'token',
        rest: unusedRest(),
        files: [userFile],
      })

      expect(result).toEqual({ id: 'msg-files' })
      const formData = requests[0]!.body!
      const payload = JSON.parse(String(formData.get('payload_json')))
      expect(
        payload.attachments.map((a: { filename: string }) => a.filename),
      ).toEqual([path.basename(userFile), 'prompt.md'])

      const files = await readFormDataFiles(formData)
      expect(files.map((f) => f.text)).toEqual(
        expect.arrayContaining([
          'user-file-body',
          expect.stringContaining('LONG_WITH_FILE'),
        ]),
      )
      expect(fs.existsSync(userFile)).toBe(true)

      const created = listKimakiPromptDirs().filter((name) => !before.has(name))
      expect(created).toEqual([])
    } finally {
      fs.unlinkSync(userFile)
    }
  })

  test('runs many concurrent long-prompt sends without ENOENT or shared temp files', async () => {
    const before = new Set(listKimakiPromptDirs())
    let nextId = 0
    let fetchCalls = 0
    installFetch(async (_input, init) => {
      // Yield so concurrent callers interleave
      await Promise.resolve()
      fetchCalls += 1
      expect(init?.body).toBeInstanceOf(FormData)
      nextId += 1
      return new Response(JSON.stringify({ id: `msg-${nextId}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        sendDiscordMessageWithOptionalAttachment({
          channelId: '333',
          prompt: `CONCURRENT_${index} ${'z'.repeat(2100)}`,
          botToken: 'token',
          rest: unusedRest(),
        }),
      ),
    )

    expect(results).toHaveLength(16)
    expect(new Set(results.map((r) => r.id)).size).toBe(16)
    expect(fetchCalls).toBe(16)

    const created = listKimakiPromptDirs().filter((name) => !before.has(name))
    expect(created).toEqual([])
  })

  test('posts short prompts through REST without fetch multipart', async () => {
    let postCalls = 0
    const shortRest = {
      post: async () => {
        postCalls += 1
        return { id: 'msg-short' }
      },
    }

    const result = await sendDiscordMessageWithOptionalAttachment({
      channelId: '444',
      prompt: 'hello short',
      botToken: 'token',
      rest: shortRest,
    })

    expect(result).toEqual({ id: 'msg-short' })
    expect(postCalls).toBe(1)
  })
})
