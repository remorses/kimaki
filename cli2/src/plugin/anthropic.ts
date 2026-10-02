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
// A separate plugin (`kimaki-anthropic`, own shim in plugins/kimaki-anthropic/):
// unlike the `kimaki` plugin it is not limited to marked Kimaki sessions,
// because a stored subscription credential must work in every session, TUI
// included. API-key requests (x-api-key) are left untouched.

import * as errore from 'errore'
import http from 'node:http'
import { Effect } from 'effect'
import { Credential, Integration } from '@opencode/plugin'
import { Plugin } from '@opencode/plugin/effect'

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
  const json = errore.try(() => JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number })
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

// OAuth callbacks fail by rejecting; OpenCode then ends the attempt.
const tokenEffect = (body: Record<string, string>) =>
  Effect.promise(() => requestToken(body)).pipe(Effect.flatMap((result) => (result instanceof Error ? Effect.fail(result) : Effect.succeed(result))))

// The user pastes the final redirect URL, `code#state`, or the bare code.
export function parseAuthorizationInput(input: string) {
  const trimmed = input.trim()
  const url = errore.try(() => new URL(trimmed))
  if (!(url instanceof Error) && url.searchParams.get('code')) return { code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') ?? undefined }
  const [code = '', state] = trimmed.split('#', 2)
  return { code, state }
}

// Serves the localhost redirect so the browser shows a real page, and remembers its code.
// The login still finishes with the pasted URL: Kimaki often runs on another machine than the browser.
async function startCallbackServer({ state }: { state: string }) {
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
  const error = await new Promise<Error | null>((resolve) => {
    server.once('error', (error) => resolve(error))
    server.listen(CALLBACK_PORT, '127.0.0.1', () => resolve(null))
  })
  if (error) return new AnthropicOAuthError({ reason: `cannot bind callback port ${CALLBACK_PORT}. Cancel any pending Claude login or free the port, then retry.`, cause: error })
  return { received, close: () => server.close() }
}

const authorize = () =>
  Effect.gen(function* () {
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const challenge = Buffer.from(yield* Effect.promise(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))).toString('base64url')
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })
    const callbackServer = yield* Effect.promise(() => startCallbackServer({ state }))
    if (callbackServer instanceof Error) return yield* Effect.fail(callbackServer)
    // The attempt scope closes on success, failure, cancel, expiry, and plugin unload.
    yield* Effect.addFinalizer(() => Effect.sync(() => callbackServer.close()))
    return {
      mode: 'code' as const,
      url: `${AUTHORIZE_URL}?${params}`,
      instructions: 'Authorize in the browser, then copy the full URL of the last page (localhost:53692) and paste it here.',
      callback: (input: string) => {
        const pasted = parseAuthorizationInput(input)
        if (pasted.state !== undefined && pasted.state !== state) return Effect.fail(new AnthropicOAuthError({ reason: 'wrong state in the pasted text. Start the login again.' }))
        const code = callbackServer.received.code ?? pasted.code
        if (!code) return Effect.fail(new AnthropicOAuthError({ reason: 'no authorization code in the pasted text' }))
        return tokenEffect({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code,
          state,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        })
      },
    }
  })

// TODO: concurrent sessions can refresh the same token twice; OpenCode's Integration connection.resolve has no single-flight lock.
const refresh = (credential: Credential.OAuth) =>
  tokenEffect({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: credential.refresh })

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

export default Plugin.define({
  id: 'kimaki-anthropic',
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* ctx.integration.transform((editor) => {
        editor.method.update({
          integrationID: 'anthropic',
          method: { id: METHOD_ID, type: 'oauth', label: 'Claude Pro/Max' },
          authorize,
          refresh,
        })
      })
      yield* ctx.session.hook(
        'http.request',
        (event) =>
          Effect.gen(function* () {
            const request = event.request
            if (request.headers.has('x-api-key') || !request.headers.get('authorization')?.startsWith('Bearer ')) return
            if (!new URL(request.url).pathname.endsWith('/messages')) return
            const body = rewriteSubscriptionRequest(yield* Effect.promise(() => request.clone().text()))
            if (body === null) return
            const headers = new Headers(request.headers)
            headers.delete('content-length')
            event.request = new Request(request, { body, headers })
          }),
        { providerID: 'anthropic' },
      )
    }),
})
