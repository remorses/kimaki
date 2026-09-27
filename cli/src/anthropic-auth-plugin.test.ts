// Tests Anthropic system prompt rewriting so project instructions survive OpenCode prompt layout changes.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadAccountStore, saveAccountStore } from './anthropic-auth-state.js'
import { applyClaudeCodeRequestIdentity } from './anthropic-account-identity.js'
import { anthropicAuthPlugin, replacer } from './anthropic-auth-plugin.js'

const { setAuth } = vi.hoisted(() => ({
  setAuth: vi.fn(),
}))

vi.mock('./plugin-opencode-client.js', () => ({
  createPluginClient: () => ({
    auth: { set: setAuth },
    tui: { showToast: vi.fn().mockResolvedValue(undefined) },
  }),
}))

let originalXdgDataHome: string | undefined
let tempDir: string

beforeEach(async () => {
  originalXdgDataHome = process.env.XDG_DATA_HOME
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'anthropic-auth-plugin-'))
  process.env.XDG_DATA_HOME = tempDir
  setAuth.mockReset()
})

afterEach(async () => {
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgDataHome
  await rm(tempDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

const oauthAccounts = Array.from({ length: 4 }, (_, index) => ({
  type: 'oauth' as const,
  refresh: `refresh-secret-${index}`,
  access: `access-secret-${index}`,
  expires: Date.now() + 60 * 60_000,
  addedAt: index + 1,
  lastUsed: index + 1,
}))

async function runOAuthRequest(statuses: number[]) {
  await saveAccountStore({ version: 1, activeIndex: 0, accounts: oauthAccounts })
  let auth = { ...oauthAccounts[0]! }
  setAuth.mockImplementation(async ({ auth: nextAuth }) => {
    auth = nextAuth
  })
  const plugin = await anthropicAuthPlugin({
    serverUrl: new URL('http://127.0.0.1:9'),
    directory: tempDir,
  } as never)
  const loader = plugin.auth?.loader
  if (!loader) throw new Error('missing loader')
  const options = await loader(async () => auth, { models: {} } as never)
  const attempts: string[] = []
  const responses = [...statuses]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      attempts.push(authorization)
      const status = responses.shift() ?? 200
      return new Response(status === 429 ? 'rate limited' : 'ok', { status })
    }),
  )
  const response = await options.fetch?.('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
  })
  return { attempts, response, store: await loadAccountStore() }
}

async function transformSystem(systemText: string) {
  const plugin = await replacer({} as never)
  const transform = plugin['experimental.chat.system.transform']
  if (!transform) throw new Error('missing system transform hook')

  const output = { system: [systemText] }
  await transform(
    {
      model: { providerID: 'anthropic' },
    } as never,
    output,
  )
  return output.system.join('\n')
}

describe('Anthropic OAuth loader', () => {
  test('missing auth does not crash on auth.type', async () => {
    const plugin = await anthropicAuthPlugin({
      serverUrl: new URL('http://127.0.0.1:9'),
      directory: '/tmp',
    } as never)
    const loader = plugin.auth?.loader
    if (!loader) throw new Error('missing loader')

    let reads = 0
    const options = await loader(
      (async () => {
        reads += 1
        if (reads === 1) {
          return {
            type: 'oauth',
            refresh: 'refresh-token',
            access: 'access-token',
            expires: Date.now() + 60_000,
          }
        }
        return undefined
      }) as never,
      { models: {} } as never,
    )

    await expect(
      options.fetch?.('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Anthropic OAuth credentials are missing')
  })

  test('rotates through each distinct account on rate limits without leaking tokens', async () => {
    const { attempts, response, store } = await runOAuthRequest([429, 429, 429, 200])

    expect(response?.status).toBe(200)
    expect(attempts).toEqual(oauthAccounts.map(({ access }) => `Bearer ${access}`))
    expect(new Set(attempts).size).toBe(4)
    expect(store.activeIndex).toBe(3)
    const responseText = await response?.text()
    for (const account of oauthAccounts) {
      expect(responseText).not.toContain(account.access)
      expect(responseText).not.toContain(account.refresh)
    }
  })

  test('stops after each account is exhausted', async () => {
    const { attempts, response, store } = await runOAuthRequest([429, 429, 429, 429])

    expect(response?.status).toBe(429)
    expect(attempts).toHaveLength(4)
    expect(new Set(attempts).size).toBe(4)
    expect(store.activeIndex).toBe(3)
  })

  test('does not rotate on a nonrotatable 400 response', async () => {
    const { attempts, response, store } = await runOAuthRequest([400])

    expect(response?.status).toBe(400)
    expect(attempts).toHaveLength(1)
    expect(store.activeIndex).toBe(0)
  })
})

describe('Anthropic OAuth request identity', () => {
  test('applies the current external Claude Code client headers', () => {
    const headers = applyClaudeCodeRequestIdentity({
      headers: new Headers({ Accept: 'application/json' }),
      accessToken: 'access-token',
    })

    expect(Object.fromEntries(headers.entries())).toMatchInlineSnapshot(`
      {
        "accept": "application/json",
        "authorization": "Bearer access-token",
        "user-agent": "claude-cli/2.1.280 (external, cli)",
        "x-app": "cli",
      }
    `)
  })
})

describe('Anthropic system prompt rewriting', () => {
  test('preserves instructions when OpenCode places them before skills', async () => {
    const transformed =
      await transformSystem(`You are OpenCode, the best coding agent on the planet.
<env>
  Working directory: /repo/site
  Platform: darwin
</env>
Instructions from: /repo/site/SOUL.md
I am Extra Chill Bot.
Skills provide specialized instructions and workflows.
Use skills wisely.`)

    expect(transformed).toMatchInlineSnapshot(`
      "
      <environment>
      <cwd>/repo/site</cwd>
      </environment>
      Read, write, and edit files under /repo/site.

      Instructions from: /repo/site/SOUL.md
      I am Extra Chill Bot.
      Skills provide specialized instructions and workflows.
      Use skills wisely."
    `)
  })

  test('preserves instructions when OpenCode places skills before them', async () => {
    const transformed =
      await transformSystem(`You are OpenCode, the best coding agent on the planet.
<env>
  Working directory: /repo/site
  Platform: darwin
</env>
Skills provide specialized instructions and workflows.
Use skills wisely.
Instructions from: /repo/site/SOUL.md
I am Extra Chill Bot.`)

    expect(transformed).toMatchInlineSnapshot(`
      "
      <environment>
      <cwd>/repo/site</cwd>
      </environment>
      Read, write, and edit files under /repo/site.

      Skills provide specialized instructions and workflows.
      Use skills wisely.
      Instructions from: /repo/site/SOUL.md
      I am Extra Chill Bot."
    `)
  })

  test('leaves text unchanged when the OpenCode env block is incomplete', async () => {
    const prompt = `You are OpenCode, the best coding agent on the planet.
<env>
  Working directory: /repo/site
Instructions from: /repo/site/SOUL.md
I am Extra Chill Bot.`

    await expect(transformSystem(prompt)).resolves.toBe(prompt)
  })
})
