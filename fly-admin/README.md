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
