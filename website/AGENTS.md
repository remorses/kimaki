<!-- Agent guidance for website package contributors and automation. -->

# website purpose

The `website` package is the HTTP layer for Kimaki onboarding.

It is responsible for:

- `GET /discord-install`: initiates better-auth Discord OAuth flow with
  `clientId`/`clientSecret` as `additionalData`.
- `GET/POST /api/auth/*`: better-auth handler (processes OAuth callback,
  session management).
- `GET /install-success`: success page after bot install.
- `GET /api/onboarding/status`: polled by CLI to detect onboarding completion.

# CRITICAL: per-request Prisma client and betterAuth instance

**NEVER use a singleton PrismaClient, pg.Pool, or betterAuth instance in this package.** Cloudflare Workers cannot reuse TCP connections across requests. A module-level singleton causes ~40% of requests to hang with error 1101 ("Worker code had hung").

Always call `createPrisma(connectionString)` and `createAuth({ env, baseURL })` inside each request handler. Never cache the result in a module-level variable.

**Always pass `state.env.HYPERDRIVE.connectionString`** to `createPrisma()`. The Hyperdrive binding provides pooled connections that cut latency from ~950ms to ~300ms. Without it, every request pays the full TCP+TLS+auth cost to PlanetScale.

```ts
// WRONG — will hang intermittently
import { createPrisma } from 'db/src/prisma.js'
const prisma = createPrisma() // module-level = singleton = broken

// WRONG — works but ~950ms per request (no pooling)
async function handleRequest() {
  const prisma = createPrisma()
  // ...
}

// CORRECT — fresh client per request, Hyperdrive pooled (~300ms)
// Inside a spiceflow route handler:
async handler({ state }) {
  const prisma = createPrisma(state.env.HYPERDRIVE.connectionString)
  // ...
}
```

# secrets: doppler is the source of truth

**Doppler is the single source of truth for all secrets.** Never add secrets
directly to Cloudflare or wrangler.json.

- **Add/update a secret:** `doppler secrets set -c dev KEY='val'` and `-c production`
- **Push to Cloudflare:** `pnpm secrets:prod`
- **Local dev:** `pnpm dev` (injects doppler dev secrets automatically)

# split with gateway-proxy

`gateway-proxy` handles Discord Gateway **WebSocket** traffic and Discord REST
proxying (`/api/v10/*`).

`website` handles **onboarding only**.

Keep this split explicit unless there is a deliberate architecture migration.

# bundle size

The CF Worker bundle must stay small for fast cold starts. Current budget
is ~2.9 MiB uncompressed / ~1.0 MiB gzipped (March 2026). CF limits are
3 MiB gzipped (free) / 10 MiB gzipped (paid).

The bundle has two parts: the **Prisma WASM query compiler** (~1.8 MiB, 62%
of total) and the **JS code** (~1.1 MiB, 38%). The WASM blob is required
for Prisma on CF Workers (no native binary). The `compilerBuild = "small"`
option in `db/schema.prisma` trades slightly slower query compilation for a
much smaller WASM (~1.8 MiB vs ~3.6 MiB with `"fast"`). The metafile
analysis below only shows the JS portion — the WASM is a separate file
shipped alongside index.js.

Use `--outdir=./tmp/bundle-out` with dry-run to inspect actual file sizes
including the WASM blob: `ls -la tmp/bundle-out/`

## debugging bundle size

Generate an esbuild metafile and analyze it:

```bash
cd website

# generate metafile + bundled output
npx wrangler deploy --dry-run --metafile=./meta.json --outdir=./tmp/bundle-out

# aggregate by package (paste into node -e or a script)
cat meta.json | node -e "
const fs = require('fs');
const meta = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
for (const [outFile, info] of Object.entries(meta.outputs || {})) {
  if (!info.inputs) continue;
  const byPkg = {};
  for (const [path, data] of Object.entries(info.inputs)) {
    let pkg;
    if (path.includes('node_modules')) {
      const parts = path.split('node_modules/');
      const last = parts[parts.length - 1];
      const pkgParts = last.split('/');
      pkg = pkgParts[0].startsWith('@')
        ? pkgParts[0] + '/' + pkgParts[1]
        : pkgParts[0];
    } else {
      pkg = '[local]';
    }
    byPkg[pkg] = (byPkg[pkg] || 0) + data.bytesInOutput;
  }
  const sorted = Object.entries(byPkg).sort((a, b) => b[1] - a[1]);
  for (const [pkg, bytes] of sorted) {
    console.log((bytes / 1024).toFixed(1) + ' KiB', pkg);
  }
}
"

# or use the esbuild web analyzer (paste meta.json contents)
# https://esbuild.github.io/analyze/
```

Clean up temp files after analysis: `rm -rf meta.json tmp/bundle-out`

## known large dependencies and mitigations

| Package | Minified size | Why it's there | Mitigation |
|---|---|---|---|
| **zod** | ~318 KiB | better-auth internal dep | none (structural) |
| **@prisma/client** | ~194 KiB | database access | needed |
| **better-auth** | ~146 KiB | auth library | needed |
| **@better-auth/core** | ~95 KiB | auth library | needed |
| **jose** | ~57 KiB | JWT, better-auth dep | none (structural) |
| **pg** | ~44 KiB | postgres driver | needed |

**better-auth/minimal** — always import from `better-auth/minimal` instead of
`better-auth`. This excludes kysely (~182 KiB minified) which is only needed
for direct DB connections, not when using the prisma adapter. This is the
official recommendation:
https://better-auth.com/docs/guides/optimizing-for-performance#bundle-size-optimization

Related issues:
- https://github.com/better-auth/better-auth/issues/2964 (bundle size / tree-shaking)
- https://github.com/better-auth/better-auth/issues/6183 (make kysely optional)

**discord-api-types** — never import from `discord-api-types/v10` barrel.
The `/v10` entry re-exports gateway, payloads, rest, rpc, and utils modules
(~204 KiB unminified) even if you only need one constant. Hardcode constants
or import from specific subpaths like `discord-api-types/payloads/v10/permissions`.

**Prisma compilerBuild** — `db/schema.prisma` sets `compilerBuild = "small"`.
This is the single biggest size win: WASM drops from 3.6 MiB to 1.8 MiB.
Never change this to `"fast"` unless query compilation latency becomes a
measured problem. After changing, run `pnpm gen` in `db/`.

**minify: true** — always keep `"minify": true` in wrangler.json. It reduces
the JS portion from ~6.3 MiB to ~1.1 MiB. The WASM blob is unaffected by
minification.
