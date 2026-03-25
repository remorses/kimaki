// Cloudflare Worker proxy for routing libSQL requests to Durable Objects.
//
// Auth model: Bearer token = "namespace:secret"
//   - namespace: identifies which Durable Object to route to
//   - secret: validated against the shared secret
//
// The proxy parses the Bearer token, validates the secret, resolves the DO
// stub via getStub(), and calls stub.hranaHandler(request) via RPC.
//
// Usage in Worker:
//
//   import { createLibsqlProxy } from 'libsqlproxy'
//
//   export default {
//     async fetch(request: Request, env: Env) {
//       const url = new URL(request.url)
//       if (url.hostname.startsWith('libsql.')) {
//         const proxy = createLibsqlProxy({
//           secret: env.LIBSQL_SECRET,
//           getStub: ({ namespace, env }) => {
//             const id = env.MY_DO.idFromString(namespace)
//             return env.MY_DO.get(id)
//           },
//         })
//         return proxy(request, env)
//       }
//       return new Response('Not found', { status: 404 })
//     },
//   }

import type { LibsqlHandler } from './handler.ts'

// Minimal DO stub interface — the stub must have a hranaHandler method
// that accepts a Request and returns a Response (via RPC).
export interface LibsqlDurableObjectStub {
  hranaHandler: LibsqlHandler
}

export interface LibsqlProxyOptions<TEnv = unknown> {
  // Shared secret for authentication. Compared against the secret portion
  // of the "namespace:secret" Bearer token.
  secret: string | ((env: TEnv) => string)

  // Resolve a Durable Object stub from the parsed namespace and env.
  getStub: (args: { namespace: string; env: TEnv }) => LibsqlDurableObjectStub
}

export function createLibsqlProxy<TEnv = unknown>(
  options: LibsqlProxyOptions<TEnv>,
): (request: Request, env: TEnv) => Promise<Response> {
  // Validate secret at creation time: must not contain ':'
  // because we split the Bearer token on the last ':' to separate namespace from secret.
  const staticSecret = typeof options.secret === 'string' ? options.secret : null
  if (staticSecret && staticSecret.includes(':')) {
    throw new Error('libsqlproxy: secret must not contain ":"')
  }

  return async (request: Request, env: TEnv): Promise<Response> => {
    // Parse "namespace:secret" from Authorization header.
    // Split on the LAST ':' so namespaces can contain ':' (e.g. UUIDs).
    const authHeader = request.headers.get('authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return Response.json(
        { error: 'Missing Authorization header. Expected: Bearer namespace:secret' },
        { status: 401 },
      )
    }

    const token = authHeader.slice('Bearer '.length)
    const lastColonIndex = token.lastIndexOf(':')
    if (lastColonIndex === -1) {
      return Response.json(
        { error: 'Invalid token format. Expected: namespace:secret' },
        { status: 401 },
      )
    }

    const namespace = token.slice(0, lastColonIndex)
    const providedSecret = token.slice(lastColonIndex + 1)

    if (!namespace) {
      return Response.json(
        { error: 'Empty namespace in token' },
        { status: 401 },
      )
    }

    // Validate secret
    const expectedSecret = typeof options.secret === 'function'
      ? options.secret(env)
      : options.secret

    // Runtime validation for dynamic secrets
    if (expectedSecret.includes(':')) {
      return Response.json(
        { error: 'Server configuration error: secret must not contain ":"' },
        { status: 500 },
      )
    }

    if (!timingSafeEqual(providedSecret, expectedSecret)) {
      return Response.json(
        { error: 'Invalid secret' },
        { status: 403 },
      )
    }

    // Resolve DO stub and forward request via RPC
    const stub = options.getStub({ namespace, env })
    return stub.hranaHandler(request)
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}
