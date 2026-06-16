# @fly.io/sdk

TypeScript SDK for Fly Machines REST and GraphQL APIs.

This package is maintained in the `fly-admin` folder of the kimaki monorepo:
https://github.com/remorses/kimaki/tree/main/fly-admin

## Install

```bash
pnpm add @fly.io/sdk
```

## Quick start

```ts
import { Client } from '@fly.io/sdk'

const client = new Client({
  apiKey: process.env.FLY_API_TOKEN || '',
})

const app = await client.App.getApp('my-app')
if (app instanceof Error) {
  console.error(app.message)
} else {
  console.log(app.name)
}
```

## Error handling

All methods return `Error | T` (via `FlyResult<T>`), following the errore style.
See https://errore.org for details about the pattern.

Status-based HTTP errors are exposed as typed classes:

- `FlyBadRequestError` (400)
- `FlyUnauthorizedError` (401)
- `FlyNotFoundError` (404)
- `FlyPreconditionFailedError` (412)
- `FlyUnprocessableEntityError` (422)
- `FlyInternalServerError` (500)
- `FlyApiError` (fallback)
- `FlyGraphQLError`

```ts
import { Client, FlyNotFoundError } from '@fly.io/sdk'

const client = new Client({
  apiKey: process.env.FLY_API_TOKEN || '',
})
const machine = await client.Machine.getMachine({
  app_name: 'my-app',
  machine_id: '123',
})

if (machine instanceof FlyNotFoundError) {
  console.error('Machine not found')
}
```

## Multi-tenant apps (one app per customer)

Fly.io recommends creating **one app per customer** for tenant isolation.
Each tenant app gets its own secrets, scaling, logs, and network.
See https://fly.io/docs/machines/guides-examples/one-app-per-user-why/ for Fly's rationale.

### Network isolation

By default all apps in the same org share one private network (6PN) and can
reach each other via `.internal` DNS. To isolate tenants, pass a **custom
`network`** when creating the app. Apps on different custom 6PNs cannot
communicate unless explicitly bridged.

See https://fly.io/docs/networking/custom-private-networks/ for details.

**Important constraints:**

- You **cannot** move an existing app to a different network — it is set at creation time
- Network names are permanent — even after all apps on a network are deleted, the ID is never reused
- Do **not** assign public IPs to tenant apps, or other tenants can reach them via the public internet
- Your control plane app can route to tenant apps using the `fly-replay` response header without exposing them publicly

### Create a tenant app with isolated network

```ts
import { Client } from '@fly.io/sdk'

const client = new Client({ apiKey: process.env.FLY_API_TOKEN || '' })

async function createTenantApp({
  tenantId,
  orgSlug,
}: {
  tenantId: string
  orgSlug: string
}) {
  const appName = `tenant-${tenantId}`

  const result = await client.App.createApp({
    org_slug: orgSlug,
    name: appName,
    network: `net-${tenantId}`, // isolated 6PN — cannot reach other tenants
  })
  if (result instanceof Error) {
    return result
  }

  // do NOT assign public IPs to tenant apps
  // route to them via fly-replay from your control plane instead

  return { appName }
}
```

### Create a machine for a tenant

```ts
async function createTenantMachine({
  tenantId,
  image,
  env,
}: {
  tenantId: string
  image: string
  env: Record<string, string>
}) {
  const appName = `tenant-${tenantId}`

  const machine = await client.Machine.createMachine({
    app_name: appName,
    region: 'iad',
    config: {
      image,
      guest: {
        cpu_kind: 'shared',
        cpus: 1,
        memory_mb: 256,
      },
      env: {
        ...env,
        TENANT_ID: tenantId,
      },
      services: [
        {
          internal_port: 8080,
          protocol: 'tcp',
          autostart: true,
          autostop: 'stop', // stop when idle, restart on incoming request
          ports: [
            { port: 443, handlers: ['tls', 'http'], force_https: true },
            { port: 80, handlers: ['http'] },
          ],
        },
      ],
      checks: {
        health: {
          type: 'http',
          port: 8080,
          path: '/health',
          interval: '30s',
          timeout: '5s',
        },
      },
    },
  })
  if (machine instanceof Error) {
    return machine
  }

  // wait for the machine to be ready
  const ready = await client.Machine.waitMachine({
    app_name: appName,
    machine_id: machine.id,
    state: 'started',
    timeout: 30,
  })
  if (ready instanceof Error) {
    return ready
  }

  return machine
}
```

### Set tenant secrets

Secrets are app-scoped — each tenant gets its own isolated set.

```ts
async function setTenantSecrets({
  tenantId,
  databaseUrl,
  apiKey,
}: {
  tenantId: string
  databaseUrl: string
  apiKey: string
}) {
  return client.App.updateSecrets({
    app_name: `tenant-${tenantId}`,
    secrets: [
      { name: 'DATABASE_URL', value: databaseUrl },
      { name: 'API_KEY', value: apiKey },
    ],
  })
}
```

### Stop and start tenant machines (cost savings)

Use `autostop: 'stop'` on services so Fly proxy handles this automatically.
For manual control:

```ts
async function suspendTenant({ tenantId }: { tenantId: string }) {
  const appName = `tenant-${tenantId}`
  const machines = await client.Machine.listMachines(appName)
  if (machines instanceof Error) {
    return machines
  }

  for (const m of machines) {
    if (m.state === 'started') {
      const result = await client.Machine.stopMachine({
        app_name: appName,
        machine_id: m.id,
      })
      if (result instanceof Error) {
        return result
      }
    }
  }
}

async function resumeTenant({ tenantId }: { tenantId: string }) {
  const appName = `tenant-${tenantId}`
  const machines = await client.Machine.listMachines(appName)
  if (machines instanceof Error) {
    return machines
  }

  for (const m of machines) {
    if (m.state === 'stopped') {
      const result = await client.Machine.startMachine({
        app_name: appName,
        machine_id: m.id,
      })
      if (result instanceof Error) {
        return result
      }
    }
  }
}
```

### Tear down a tenant

```ts
async function teardownTenant({ tenantId }: { tenantId: string }) {
  const appName = `tenant-${tenantId}`

  const machines = await client.Machine.listMachines(appName)
  if (machines instanceof Error) {
    return machines
  }

  for (const m of machines) {
    const result = await client.Machine.deleteMachine({
      app_name: appName,
      machine_id: m.id,
      force: true,
    })
    if (result instanceof Error) {
      return result
    }
  }

  return client.App.deleteApp(appName)
}
```

### Route requests to tenant apps with `fly-replay`

Your control plane (router) app lives on the default network with a public IP.
It uses the `fly-replay` response header to forward requests to isolated tenant
apps without exposing them publicly. Tenant apps need services configured but
no public IPs.

```ts
// in your control plane / router app
function handleRequest(req: Request): Response {
  const tenantId = extractTenantFromRequest(req)

  return new Response('', {
    status: 307,
    headers: {
      'fly-replay': `app=tenant-${tenantId}`,
    },
  })
}
```

### Architecture overview

```
┌──────────────────────────────────────────────────────┐
│  Organization: my-saas                               │
│                                                      │
│  ┌──────────────────────────────────┐                │
│  │ network: "default"               │                │
│  │                                  │                │
│  │  control-plane-app               │                │
│  │  (public IP, router/API)         │                │
│  │  routes via fly-replay ──────────┼──► tenants     │
│  └──────────────────────────────────┘                │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐│
│  │ net: net-a    │  │ net: net-b    │  │ net: net-c   ││
│  │ tenant-alice  │  │ tenant-bob    │  │ tenant-carol ││
│  │ no public IP  │  │ no public IP  │  │ no public IP ││
│  │ can't see     │  │ can't see     │  │ can't see    ││
│  │ bob or carol  │  │ alice/carol   │  │ alice/bob    ││
│  └──────────────┘  └──────────────┘  └──────────────┘│
└──────────────────────────────────────────────────────┘
```
