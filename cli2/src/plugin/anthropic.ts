// Claude Pro/Max subscription login for the OpenCode `anthropic` provider.
//
// OpenCode V2 ships no Anthropic OAuth. This adds one OAuth method; OpenCode
// stores the credential, refreshes it through `refresh`, and already sends an
// OAuth access token as `authorization: Bearer` (model-resolver.ts
// nativeCredentialSettings). Request changes Anthropic requires for
// subscription tokens, verified 2026-10-01 by bisecting a real OpenCode request:
// - the first system block is exactly the Claude Code identity, else 429;
// - OpenCode's `<env>` block is re-wrapped, else "third-party" extra-usage billing.
// No beta header, user agent, or tool rename is needed on /v1/messages.
//
// Unlike the other Kimaki hooks this is not limited to marked Kimaki sessions:
// a stored subscription credential must work in every session, TUI included.
// API-key requests (x-api-key) are left untouched.

import * as errore from 'errore'
import http, { type Server } from 'node:http'
import { Credential, Integration, type Plugin } from '@opencode/plugin'

type Context = Parameters<Plugin.Plugin['setup']>[0]

const CLIENT_ID = Buffer.from('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl', 'base64').toString('utf8')
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CALLBACK_PORT = 53692
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
const CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.280 (external, cli)'
const METHOD_ID = Integration.MethodID.make('claude-pro-max')
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

export class AnthropicOAuthError extends errore.createTaggedError({
  name: 'AnthropicOAuthError',
  message: 'Claude Pro/Max login failed: $reason',
}) {}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number }

async function requestToken(body: Record<string, string>) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    // OpenCode sets `user-agent: opencode/...` on every fetch; the token endpoint answers 429 to it.
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': CLAUDE_CODE_USER_AGENT },
    body: JSON.stringify(body),
  }).catch((cause) => new AnthropicOAuthError({ reason: 'token request failed', cause }))
  if (response instanceof Error) return response
  const text = await response.text().catch(() => '')
  if (!response.ok) return new AnthropicOAuthError({ reason: `token endpoint returned ${response.status}: ${text}` })
  const json = errore.try(() => JSON.parse(text) as TokenResponse)
  if (json instanceof Error) return new AnthropicOAuthError({ reason: 'token response is not JSON', cause: json })
  if (!json.access_token || !json.refresh_token || !json.expires_in) return new AnthropicOAuthError({ reason: 'token response has no tokens' })
  return Credential.OAuth.make({
    type: 'oauth',
    methodID: METHOD_ID,
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  })
}

// The user pastes the final redirect URL, `code#state`, or the bare code.
export function parseAuthorizationInput(input: string) {
  const trimmed = input.trim()
  const url = errore.try(() => new URL(trimmed))
  if (!(url instanceof Error) && url.searchParams.get('code')) return { code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') ?? '' }
  const [code = '', state = ''] = trimmed.split('#', 2)
  return { code, state }
}

// One login at a time: a new attempt closes the previous listener so port 53692 is free.
const active: { server: Server | null } = { server: null }

// Serves the localhost redirect so the browser shows a real page, and remembers the code it carries.
// The login still finishes with the pasted URL: Kimaki often runs on another machine than the browser.
async function startCallbackServer({ state }: { state: string }) {
  active.server?.close()
  const received: { code: string | null } = { code: null }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', REDIRECT_URI)
    const code = url.searchParams.get('code')
    if (url.pathname !== '/callback' || !code || url.searchParams.get('state') !== state) {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('Claude login failed: missing code or wrong state. Start the login again.')
      return
    }
    received.code = code
    response.writeHead(200, { 'content-type': 'text/plain' }).end('Claude authorized. Copy the URL of this page and paste it where you started the login.')
  })
  const timeout = setTimeout(() => server.close(), 10 * 60_000)
  server.on('close', () => clearTimeout(timeout))
  active.server = server
  // A busy port only disables the localhost page; pasting the URL still works.
  await new Promise<void>((resolve) => {
    server.once('error', () => resolve())
    server.listen(CALLBACK_PORT, '127.0.0.1', () => resolve())
  })
  return { received, close: () => server.close() }
}

async function authorize() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
  })
  const callbackServer = await startCallbackServer({ state: verifier })
  return {
    mode: 'code' as const,
    url: `${AUTHORIZE_URL}?${params}`,
    instructions: 'Authorize in the browser, then copy the full URL of the last page (localhost:53692) and paste it here.',
    callback: async (input: string) => {
      const pasted = parseAuthorizationInput(input)
      const code = callbackServer.received.code ?? pasted.code
      if (!code) throw new AnthropicOAuthError({ reason: 'no authorization code in the pasted text' })
      const credential = await requestToken({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        state: verifier,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      })
      if (credential instanceof Error) throw credential
      // Close only on success: a bad paste must not take the localhost page down.
      callbackServer.close()
      return credential
    },
  }
}

async function refresh(credential: Credential.OAuth) {
  const next = await requestToken({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: credential.refresh })
  if (next instanceof Error) throw next
  return next
}

// Anthropic bills subscription requests that carry OpenCode's exact environment
// block as third-party usage ("Third-party apps now draw from your extra usage").
// Changing its wrapper keeps every line for the model and avoids the fingerprint.
const OPENCODE_ENV_BLOCK = /Here is some useful information about the environment you are running in:\n<env>\n([\s\S]*?)<\/env>/

// The body comes from OpenCode's Anthropic provider, so its shape is known.
type MessagesBody = { system?: string | Array<{ type: string; text?: string }> }

// Rewrites an Anthropic Messages body for a subscription token: the Claude Code
// identity first, OpenCode's environment block re-wrapped. Null when nothing changes.
export function rewriteSubscriptionRequest(body: string): string | null {
  const payload = errore.try(() => JSON.parse(body) as MessagesBody)
  if (payload instanceof Error) return null
  const blocks = typeof payload.system === 'string' ? [{ type: 'text', text: payload.system }] : (payload.system ?? [])
  const rewrapped = blocks.map((block) => (block.text === undefined ? block : { ...block, text: block.text.replace(OPENCODE_ENV_BLOCK, '<environment>\n$1</environment>') }))
  const next = rewrapped[0]?.text === CLAUDE_CODE_IDENTITY ? rewrapped : [{ type: 'text', text: CLAUDE_CODE_IDENTITY }, ...rewrapped]
  if (JSON.stringify(next) === JSON.stringify(payload.system)) return null
  return JSON.stringify({ ...payload, system: next })
}

export async function setupAnthropicOAuth(ctx: Context) {
  await ctx.integration.transform((editor) => {
    editor.method.update({
      integrationID: 'anthropic',
      method: { id: METHOD_ID, type: 'oauth', label: 'Claude Pro/Max' },
      authorize,
      refresh,
    })
  })
  await ctx.session.hook('http.request', async (event) => {
    const request = event.request
    if (request.headers.has('x-api-key') || !request.headers.get('authorization')?.startsWith('Bearer ')) return
    if (!new URL(request.url).pathname.endsWith('/messages')) return
    const body = rewriteSubscriptionRequest(await request.clone().text())
    if (body === null) return
    const headers = new Headers(request.headers)
    headers.delete('content-length')
    event.request = new Request(request, { body, headers })
  }, { providerID: 'anthropic' })
}
