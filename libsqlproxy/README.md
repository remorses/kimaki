# libsqlproxy

Runtime-agnostic Hrana v2 HTTP server for SQLite. Expose any SQLite database via the libSQL remote protocol.

Expose your Cloudflare Durable Object data to data explorers like [Drizzle Studio](https://github.com/drizzle-team/drizzle-orm) and TablePlus so you can browse, edit, and manage your DO storage from a GUI. Also works with Node.js `libsql`, `better-sqlite3`, or any custom SQL driver.

Connect with `@libsql/client`, Drizzle Studio, TablePlus, or any tool that speaks the libSQL remote protocol.

## Install

```bash
npm install libsqlproxy
```

## Cloudflare Workers + Durable Objects

Expose a Durable Object's embedded SQLite over the libSQL protocol.

**wrangler.json:**

```jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-20",
  "routes": [
    { "pattern": "libsql.example.com", "custom_domain": true },
    { "pattern": "example.com", "custom_domain": true }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "MY_DO", "class_name": "MyDO" }
    ]
  }
}
```

**Durable Object** (`src/my-do.ts`):

```ts
import { DurableObject } from 'cloudflare:workers'
import { createLibsqlHandler, durableObjectExecutor, type LibsqlHandler } from 'libsqlproxy'

export class MyDO extends DurableObject {
  // Must be a prototype method, not a property assignment —
  // Cloudflare Workers RPC only dispatches to prototype methods.
  #hrana: LibsqlHandler

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.#hrana = createLibsqlHandler(durableObjectExecutor(ctx.storage))
  }

  async hranaHandler(request: Request): Promise<Response> {
    return this.#hrana(request)
  }
}
```

**Worker** (`src/index.ts`):

```ts
import { createLibsqlProxy } from 'libsqlproxy'

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)

    // Only handle libsql proxy on the dedicated hostname
    if (url.hostname.startsWith('libsql.')) {
      const proxy = createLibsqlProxy({
        secret: env.LIBSQL_SECRET,
        getStub: ({ namespace, env }) => {
          const id = env.MY_DO.idFromString(namespace)
          return env.MY_DO.get(id)
        },
      })
      return proxy(request, env)
    }

    // Normal Worker logic
    return new Response('Hello')
  },
}
```

**Connect from anywhere:**

```ts
import { createClient } from '@libsql/client'

const client = createClient({
  url: 'https://libsql.example.com',
  authToken: 'my-durable-object-id:my-shared-secret',
  //          ^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^
  //          namespace (DO ID)       shared secret
})

await client.execute('SELECT * FROM users')
```

The `authToken` format is `namespace:secret` where:
- **namespace** identifies which Durable Object to route to
- **secret** is validated against the shared secret configured in the Worker

This works with TablePlus, Drizzle Studio, and any tool that accepts a libSQL URL + auth token.

## Node.js

```ts
import http from 'node:http'
import Database from 'libsql'
import {
  createLibsqlHandler,
  createLibsqlNodeHandler,
  libsqlExecutor,
} from 'libsqlproxy'

const database = new Database('my.db')
const handler = createLibsqlHandler(libsqlExecutor(database))
const nodeHandler = createLibsqlNodeHandler(handler, {
  auth: { bearer: 'my-secret-token' },
})

http.createServer(nodeHandler).listen(8080)
// Connect with: libsql://localhost:8080, authToken: 'my-secret-token'
```

## Custom SQL Driver

Implement the `LibsqlExecutor` interface for any database:

```ts
import { createLibsqlHandler } from 'libsqlproxy'

const handler = createLibsqlHandler({
  executeSql(sql, params) {
    // Return { cols, rows, affected_row_count, last_insert_rowid }
    return myDriver.query(sql, params)
  },
  execRaw(sql) {
    // Execute raw SQL (multiple statements, no results)
    myDriver.exec(sql)
  },
})

// handler is (Request) => Promise<Response>
```

Both sync and async executors are supported.

## API

| Export | Description |
|---|---|
| `createLibsqlHandler(executor)` | Core handler. Takes a `LibsqlExecutor`, returns `(Request) => Promise<Response>` |
| `createLibsqlNodeHandler(handler, opts?)` | Node.js adapter. Wraps the fetch handler for `http.createServer()` |
| `createLibsqlProxy(opts)` | Cloudflare Worker proxy. Parses `namespace:secret` from Bearer token, routes to DO |
| `libsqlExecutor(database)` | Adapter for `libsql` / `better-sqlite3` |
| `durableObjectExecutor(storage)` | Adapter for CF Durable Object `ctx.storage` |

## Protocol Support

Implements the [Hrana v2 HTTP protocol](https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md):

- `execute` - single statement with positional/named params
- `batch` - multi-step conditional execution (ok/not/and/or)
- `sequence` - raw SQL semicolon-separated execution
- `describe` - column/parameter info without executing
- `store_sql` / `close_sql` - stream-scoped SQL caching
- `close` - stream teardown
- Baton-based stateful streams for interactive transactions

## License

MIT
