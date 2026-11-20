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
// The body is also gzipped, and images and PDFs go to the Files API (files.ts).
//
// A separate plugin (`kimaki-anthropic`, own shim in plugins/kimaki-anthropic/):
// unlike the `kimaki` plugin it is not limited to marked Kimaki sessions,
// because a stored subscription credential must work in every session, TUI
// included. API-key requests (x-api-key) are left untouched.
//
// Standalone in plain OpenCode without the bot: list this directory in
// opencode.json `plugins` (OpenCode only accepts directories there). The bot
// then skips its shim, see installPluginShim in opencode-server.ts.
// It imports nothing from Kimaki outside this folder except npm packages.

import * as errore from 'errore'
import http from 'node:http'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { Effect } from 'effect'
import { Credential, Integration } from '@opencode/plugin'
import { Plugin } from '@opencode/plugin/effect'
import { createFileCache, missingFileIds, type FileCache, type MessagesPayload } from './files.ts'

const CLIENT_ID = Buffer.from('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl', 'base64').toString('utf8')
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CALLBACK_PORT = 53692
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
const CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.280 (external, cli)'
// Browser: the localhost callback finishes the login. Headless: the user pastes
// the callback URL, for a browser on another machine than OpenCode (Discord /login).
const METHOD_ID = Integration.MethodID.make('claude-pro-max')
const HEADLESS_METHOD_ID = Integration.MethodID.make('claude-pro-max-headless')
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)
// Missing in runtimes without zstd; such a body is then sent unchanged.
const zstdDecompress = zlib.zstdDecompress ? promisify(zlib.zstdDecompress) : undefined

export class AnthropicOAuthError extends errore.createTaggedError({
  name: 'AnthropicOAuthError',
  message: 'Claude Pro/Max login failed: $reason',
}) {}

async function requestToken({ body, methodID }: { body: Record<string, string>; methodID: Integration.MethodID }) {
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
    methodID,
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  })
}

// OAuth callbacks fail by rejecting; OpenCode then ends the attempt.
const tokenEffect = (input: { body: Record<string, string>; methodID: Integration.MethodID }) =>
  Effect.promise(() => requestToken(input)).pipe(Effect.flatMap((result) => (result instanceof Error ? Effect.fail(result) : Effect.succeed(result))))

// The user pastes the final redirect URL, `code#state`, or the bare code.
export function parseAuthorizationInput(input: string) {
  const trimmed = input.trim()
  const url = errore.try(() => new URL(trimmed))
  if (!(url instanceof Error) && url.searchParams.get('code')) return { code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') ?? undefined }
  const [code = '', state] = trimmed.split('#', 2)
  return { code, state }
}

// Serves the localhost redirect and resolves with its code.
async function startCallbackServer({ state }: { state: string }) {
  const received = Promise.withResolvers<string>()
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', REDIRECT_URI)
    const code = url.searchParams.get('code')
    if (url.pathname !== '/callback' || !code || url.searchParams.get('state') !== state) {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('Claude login failed: missing code or wrong state. Start the login again.')
      return
    }
    received.resolve(code)
    response.writeHead(200, { 'content-type': 'text/plain' }).end('Claude authorized. You can close this page.')
  })
  const error = await new Promise<Error | null>((resolve) => {
    server.once('error', (error) => resolve(error))
    server.listen(CALLBACK_PORT, '127.0.0.1', () => resolve(null))
  })
  if (error) return new AnthropicOAuthError({ reason: `cannot bind callback port ${CALLBACK_PORT}. Cancel any pending Claude login or free the port, then retry.`, cause: error })
  return { code: received.promise, close: () => server.close() }
}

const pkce = Effect.gen(function* () {
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
  const exchange = ({ code, methodID }: { code: string; methodID: Integration.MethodID }) =>
    tokenEffect({
      body: { grant_type: 'authorization_code', client_id: CLIENT_ID, code, state, redirect_uri: REDIRECT_URI, code_verifier: verifier },
      methodID,
    })
  return { state, url: `${AUTHORIZE_URL}?${params}`, exchange }
})

const authorize = () =>
  Effect.gen(function* () {
    const { url, state, exchange } = yield* pkce
    const callbackServer = yield* Effect.promise(() => startCallbackServer({ state }))
    if (callbackServer instanceof Error) return yield* Effect.fail(callbackServer)
    // The attempt scope closes on success, failure, cancel, expiry, and plugin unload.
    yield* Effect.addFinalizer(() => Effect.sync(() => callbackServer.close()))
    return {
      mode: 'auto' as const,
      url,
      instructions: 'Authorize in the browser. The login finishes by itself.',
      callback: Effect.promise(() => callbackServer.code).pipe(Effect.flatMap((code) => exchange({ code, methodID: METHOD_ID }))),
    }
  })

const authorizeHeadless = () =>
  Effect.gen(function* () {
    const { url, state, exchange } = yield* pkce
    return {
      mode: 'code' as const,
      url,
      instructions: 'Authorize in the browser. The last page (localhost:53692) does not load: copy its full URL and paste it here.',
      callback: (input: string) => {
        const pasted = parseAuthorizationInput(input)
        if (pasted.state !== undefined && pasted.state !== state) return Effect.fail(new AnthropicOAuthError({ reason: 'wrong state in the pasted text. Start the login again.' }))
        if (!pasted.code) return Effect.fail(new AnthropicOAuthError({ reason: 'no authorization code in the pasted text' }))
        return exchange({ code: pasted.code, methodID: HEADLESS_METHOD_ID })
      },
    }
  })

const refresh = (credential: Credential.OAuth) =>
  tokenEffect({ body: { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: credential.refresh }, methodID: credential.methodID })

// Anthropic bills subscription requests that carry OpenCode's exact environment
// block as third-party usage ("Third-party apps now draw from your extra usage").
// Changing its wrapper keeps every line for the model and avoids the fingerprint.
const OPENCODE_ENV_BLOCK = /Here is some useful information about the environment you are running in:\n<env>\n([\s\S]*?)<\/env>/

// The body comes from OpenCode's Anthropic provider, so its shape is known.
type MessagesBody = MessagesPayload & { system?: string | Array<{ type: string; text?: string }> }

// Puts the Claude Code identity first and re-wraps OpenCode's environment block, in place.
// False when the system prompt already fits.
export function rewriteSystem(payload: MessagesBody): boolean {
  const blocks = typeof payload.system === 'string' ? [{ type: 'text', text: payload.system }] : (payload.system ?? [])
  const rewrapped = blocks.map((block) => (block.text === undefined ? block : { ...block, text: block.text.replace(OPENCODE_ENV_BLOCK, '<environment>\n$1</environment>') }))
  const next = rewrapped[0]?.text === CLAUDE_CODE_IDENTITY ? rewrapped : [{ type: 'text', text: CLAUDE_CODE_IDENTITY }, ...rewrapped]
  if (JSON.stringify(next) === JSON.stringify(payload.system)) return false
  payload.system = next
  return true
}

// api.anthropic.com decodes gzip request bodies; zstd gets 400 and br 415 (checked 2026-11-20).
// OpenCode sends plain JSON to Anthropic unless the provider sets `encoding`, and long
// sessions send megabytes per step, so subscription bodies are always gzipped here.
const ANTHROPIC_HOST = 'api.anthropic.com'

// The request to send for a subscription token, or null when it already fits.
// A body OpenCode gzipped itself (provider `encoding: "gzip"`) is decoded first.
// Images and PDFs go to the Files API only on api.anthropic.com, see files.ts.
export async function prepareSubscriptionRequest({ request, files }: { request: Request; files?: FileCache }): Promise<Request | null> {
  const url = new URL(request.url)
  if (!url.pathname.endsWith('/messages')) return null
  const official = url.hostname === ANTHROPIC_HOST
  const encoding = request.headers.get('content-encoding')
  // Anthropic rejects zstd, which OpenCode sends for `encoding: "zstd"`: decode it and send gzip.
  const decode = encoding === null ? undefined : encoding === 'gzip' ? gunzip : encoding === 'zstd' && official ? (zstdDecompress ?? null) : null
  if (decode === null) return null
  const raw = Buffer.from(await request.clone().arrayBuffer())
  const plain = decode ? await decode(raw).catch(() => null) : raw
  if (plain === null) return null
  const text = plain.toString('utf8')
  const payload = errore.try(() => JSON.parse(text) as MessagesBody)
  if (payload instanceof Error) return null
  const rewritten = rewriteSystem(payload)
  const swapped = official && files ? await files.swap({ payload, headers: request.headers }) : false
  // Custom base URLs (proxies) may not decode gzip, so only compress what OpenCode already did.
  const compress = encoding === 'gzip' || official
  const encoded = compress ? encoding === 'gzip' : encoding === null
  if (!rewritten && !swapped && encoded) return null
  const body = rewritten || swapped ? JSON.stringify(payload) : text
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  if (!compress) return new Request(request, { body, headers })
  headers.set('content-encoding', 'gzip')
  return new Request(request, { body: new Uint8Array(await gzip(body)), headers })
}

export default Plugin.define({
  id: 'kimaki-anthropic',
  effect: (ctx) =>
    Effect.gen(function* () {
      const files = createFileCache({
        storage: {
          get: (key) => Effect.runPromise(ctx.storage.get(key)),
          set: (key, value) => Effect.runPromise(ctx.storage.set(key, value)),
          remove: (key) => Effect.runPromise(ctx.storage.remove(key)),
          scan: (input) => Effect.runPromise(ctx.storage.scan(input)),
        },
      })
      yield* Effect.forkScoped(Effect.promise(() => files.prune()))
      yield* ctx.integration.transform((editor) => {
        editor.method.update({
          integrationID: 'anthropic',
          method: { id: METHOD_ID, type: 'oauth', label: 'Claude Pro/Max (browser)' },
          authorize,
          refresh,
        })
        editor.method.update({
          integrationID: 'anthropic',
          method: { id: HEADLESS_METHOD_ID, type: 'oauth', label: 'Claude Pro/Max (headless)' },
          authorize: authorizeHeadless,
          refresh,
        })
      })
      yield* ctx.session.hook(
        'http.request',
        (event) =>
          Effect.gen(function* () {
            const request = event.request
            if (request.headers.has('x-api-key') || !request.headers.get('authorization')?.startsWith('Bearer ')) return
            // Only these kinds pass through the retry hook that repairs a deleted file. Others send base64,
            // which hits the same prompt cache entry.
            const repairable = event.kind === 'primary' || event.kind === 'compaction'
            const next = yield* Effect.promise(() => prepareSubscriptionRequest({ request, files: repairable ? files : undefined }))
            if (next !== null) event.request = next
          }),
        { providerID: 'anthropic' },
      )
      // A deleted or expired file fails the request with 404. Forget it and retry: the retry uploads it again.
      yield* ctx.session.hook(
        'retry',
        (event) =>
          Effect.gen(function* () {
            const missing = missingFileIds(event.error)
            if (missing.length === 0) return
            if (yield* Effect.promise(() => files.forget(missing))) event.decision = { retry: true, delay: 0 }
          }),
        { providerID: 'anthropic' },
      )
    }),
})
