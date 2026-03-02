<!-- Agent guidance for website package contributors and automation. -->

# website purpose

The `website` package is the HTTP layer for Kimaki onboarding.

It is responsible for:

- `GET /oauth/callback`: finalize OAuth install flow and persist
  `client_id + secret + guild_id` mapping.
- `GET /api/onboarding/status`: polled by CLI to detect onboarding completion.

# CRITICAL: per-request Prisma client

**NEVER use a singleton PrismaClient or pg.Pool in this package.** Cloudflare Workers cannot reuse TCP connections across requests. A module-level singleton causes ~40% of requests to hang with error 1101 ("Worker code had hung").

Always call `createPrisma()` inside each request handler to get a fresh client. Never cache the result in a module-level variable.

```ts
// WRONG — will hang intermittently
import { createPrisma } from 'db/src/prisma.js'
const prisma = createPrisma() // module-level = singleton = broken

// CORRECT — fresh client per request
async function handleRequest(c: Context) {
  const prisma = createPrisma()
  // ...
}
```

# split with gateway-proxy

`gateway-proxy` handles Discord Gateway **WebSocket** traffic and Discord REST
proxying (`/api/v10/*`).

`website` handles **onboarding only**.

Keep this split explicit unless there is a deliberate architecture migration.
