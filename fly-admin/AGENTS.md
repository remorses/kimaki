# fly-admin

Vendored TypeScript client for the Fly Machines REST and GraphQL APIs.

## Original source

Forked from [supabase/fly-admin](https://github.com/supabase/fly-admin) (v1.6.1, archived/unmaintained).

Key changes from upstream:
- Native `fetch` instead of `cross-fetch` (zero runtime deps)
- ESM + modern TypeScript with `.ts` imports
- Added `execMachine`, `releaseLease`, metadata CRUD, `suspendMachine`, memory management, org-level listing

## OpenAPI spec (source of truth)

The Fly Machines OpenAPI 3.0 spec is the canonical reference for all endpoints, request/response shapes, and field types:

```
https://docs.machines.dev/spec/openapi3.json
```

When adding new routes, updating request/response types, or fixing field mismatches, always fetch this spec and use it as the source of truth. The original supabase/fly-admin types were auto-generated from an older swagger spec and may be outdated.

## Architecture

```
src/
├── index.ts          re-exports everything, createClient() factory
├── client.ts         HTTP client (fetch-based), REST + GraphQL helpers
├── types.ts          generated API types from OpenAPI spec
├── machine.ts        Machine CRUD, lifecycle, exec, leases, metadata, memory
├── volume.ts         Volume CRUD, extend, snapshots
├── app.ts            App CRUD (REST + GraphQL for detailed view)
├── network.ts        IP address allocation (GraphQL mutations)
├── organization.ts   Org lookup (GraphQL)
├── regions.ts        Region listing (GraphQL)
└── secret.ts         Secrets management (GraphQL mutations)
```

## Adding new endpoints

1. Fetch the OpenAPI spec: `curl -s https://docs.machines.dev/spec/openapi3.json | jq .`
2. Find the endpoint path and its request/response schemas
3. Add the typed request/response interfaces to the relevant module
4. Add the method to the class following existing patterns
5. Export new types from `index.ts`
6. Run `pnpm tsc --noEmit` to validate

## Notes

- `restOrThrow` accepts an optional `headers` param (4th arg) for custom headers like `fly-machine-lease-nonce`
- GraphQL endpoints (network, secrets, org, regions) use `gqlPostOrThrow` with inline query strings
- REST endpoints use `restOrThrow` against `https://api.machines.dev/v1/`
- GraphQL endpoints hit `https://api.fly.io/graphql`
